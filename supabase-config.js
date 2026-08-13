/**
 * Supabase + WebRTC DataChannel Hybrid Multiplayer Engine & UI Framework
 * Project: My first project (oxagjrukohzqmolxfluk)
 *
 * Architecture:
 *   ┌────────────────────────┐
 *   │        Supabase        │
 *   │                        │
 *   │ • Auth & Profiles      │
 *   │ • Matchmaking / Lobby  │
 *   │ • Game Results History │
 *   │ • WebRTC Signaling     │
 *   └───────────┬────────────┘
 *               │ (SDP / ICE Signaling)
 *               ▼
 *   ┌────────────────────────┐
 *   │         WebRTC         │
 *   │      DataChannel       │
 *   └───────────┬────────────┘
 *               │
 *   ┌───────────┴───────────┐
 *   ▼                       ▼
 * Player A (Browser)    Player B (Browser)
 */

(function(window) {
  const SUPABASE_URL = 'https://oxagjrukohzqmolxfluk.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94YWdqcnVrb2h6cW1vbHhmbHVrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1MzgwNjMsImV4cCI6MjEwMjExNDA2M30.cu-ov8BqB5-_C43Iu-i_RoWAfypQUMnpnROIQw7-sHs';

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  };

  let supabaseClient = null;
  let activeChannel = null;
  let currentRoom = null;
  let localPlayer = { id: null, name: 'Player 1', isHost: false, slot: 1, avatar: '🎮' };
  let peerConnection = null;
  let dataChannel = null;
  let p2pActive = false;
  let userCallbacks = {};

  function initClient() {
    if (!supabaseClient && window.supabase) {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return supabaseClient;
  }

  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 5; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  function getStoredPlayerId() {
    let pid = localStorage.getItem('arcade_player_id');
    if (!pid) {
      pid = 'usr_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('arcade_player_id', pid);
    }
    return pid;
  }

  const SupabaseMultiplayer = {
    getUrl() { return SUPABASE_URL; },
    getAnonKey() { return SUPABASE_ANON_KEY; },
    getClient() { return initClient(); },
    getLocalPlayer() { return localPlayer; },
    getCurrentRoom() { return currentRoom; },
    isP2P() { return p2pActive; },

    // --- Profile & Stats Management ---
    async getOrCreateProfile(playerName = 'Player', avatar = '🎮') {
      const client = initClient();
      const playerId = getStoredPlayerId();
      if (!client) return { player_id: playerId, username: playerName, avatar, matches_played: 0, wins: 0 };

      try {
        const { data: existing } = await client
          .from('player_profiles')
          .select('*')
          .eq('player_id', playerId)
          .single();

        if (existing) {
          if (existing.username !== playerName || existing.avatar !== avatar) {
            await client.from('player_profiles').update({ username: playerName, avatar }).eq('player_id', playerId);
          }
          return existing;
        }

        const { data: created } = await client
          .from('player_profiles')
          .insert([{ player_id: playerId, username: playerName, avatar, matches_played: 0, wins: 0 }])
          .select()
          .single();

        return created || { player_id: playerId, username: playerName, avatar };
      } catch (e) {
        console.warn('Profile sync warning:', e);
        return { player_id: playerId, username: playerName, avatar, matches_played: 0, wins: 0 };
      }
    },

    async recordMatchResult(gameId, winnerSlot, p1Score = 0, p2Score = 0) {
      const client = initClient();
      if (!client || !currentRoom) return;

      const isP1Win = winnerSlot === 1;
      const winnerName = isP1Win ? currentRoom.host_name : (currentRoom.guest_name || 'Player 2');
      const loserName = isP1Win ? (currentRoom.guest_name || 'Player 2') : currentRoom.host_name;
      const winnerScore = isP1Win ? p1Score : p2Score;
      const loserScore = isP1Win ? p2Score : p1Score;

      try {
        await client.from('game_results').insert([{
          game_id: gameId,
          room_code: currentRoom.room_code,
          winner_name: winnerName,
          loser_name: loserName,
          winner_score: winnerScore,
          loser_score: loserScore,
          duration_seconds: 0
        }]);

        // Increment stats if this is local player
        const mySlot = localPlayer.slot;
        const won = (winnerSlot === mySlot);
        const myPid = getStoredPlayerId();

        const { data: profile } = await client.from('player_profiles').select('matches_played, wins').eq('player_id', myPid).single();
        if (profile) {
          await client.from('player_profiles').update({
            matches_played: (profile.matches_played || 0) + 1,
            wins: (profile.wins || 0) + (won ? 1 : 0),
            updated_at: new Date().toISOString()
          }).eq('player_id', myPid);
        }
      } catch (e) {
        console.warn('Could not record match result:', e);
      }
    },

    // --- Lobby & Room Matchmaking ---
    async createRoom(gameId, playerName = 'Host Player', avatar = '🎮') {
      const client = initClient();
      if (!client) throw new Error('Supabase client not loaded');

      const roomCode = generateRoomCode();
      const playerId = getStoredPlayerId();
      localPlayer = { id: playerId, name: playerName, isHost: true, slot: 1, avatar };

      await this.getOrCreateProfile(playerName, avatar);

      const { data, error } = await client
        .from('game_rooms')
        .insert([{
          room_code: roomCode,
          game_id: gameId,
          host_name: playerName,
          guest_name: null,
          status: 'waiting',
          state: {}
        }])
        .select()
        .single();

      if (error) throw error;
      currentRoom = data;
      return { room: data, player: localPlayer };
    },

    async joinRoom(roomCode, playerName = 'Guest Player', avatar = '🕹️') {
      const client = initClient();
      if (!client) throw new Error('Supabase client not loaded');

      const cleanCode = roomCode.toUpperCase().trim();
      const { data: room, error: fetchErr } = await client
        .from('game_rooms')
        .select('*')
        .eq('room_code', cleanCode)
        .single();

      if (fetchErr || !room) throw new Error('Room not found! Check code and try again.');
      if (room.status === 'playing' && room.guest_name) {
        throw new Error('Room is already full!');
      }

      const playerId = getStoredPlayerId();
      localPlayer = { id: playerId, name: playerName, isHost: false, slot: 2, avatar };

      await this.getOrCreateProfile(playerName, avatar);

      const { data: updatedRoom, error: updateErr } = await client
        .from('game_rooms')
        .update({
          guest_name: playerName,
          status: 'playing',
          updated_at: new Date().toISOString()
        })
        .eq('room_code', cleanCode)
        .select()
        .single();

      if (updateErr) throw updateErr;
      currentRoom = updatedRoom;
      return { room: updatedRoom, player: localPlayer };
    },

    async quickMatch(gameId, playerName = 'Player') {
      const client = initClient();
      if (!client) throw new Error('Supabase client not loaded');

      const { data: openRooms } = await client
        .from('game_rooms')
        .select('*')
        .eq('game_id', gameId)
        .eq('status', 'waiting')
        .limit(1);

      if (openRooms && openRooms.length > 0) {
        return await this.joinRoom(openRooms[0].room_code, playerName);
      } else {
        return await this.createRoom(gameId, playerName);
      }
    },

    // --- WebRTC Signaling & DataChannel Establishment ---
    _setupWebRTC(isHost) {
      if (peerConnection) {
        try { peerConnection.close(); } catch (e) {}
      }
      p2pActive = false;

      peerConnection = new RTCPeerConnection(RTC_CONFIG);

      peerConnection.onicecandidate = (event) => {
        if (event.candidate && activeChannel) {
          activeChannel.send({
            type: 'broadcast',
            event: 'webrtc_signal',
            payload: { type: 'ice', candidate: event.candidate, senderSlot: localPlayer.slot }
          });
        }
      };

      if (isHost) {
        dataChannel = peerConnection.createDataChannel('gameplay', { ordered: true });
        this._bindDataChannel(dataChannel);

        peerConnection.createOffer()
          .then((offer) => peerConnection.setLocalDescription(offer))
          .then(() => {
            if (activeChannel) {
              activeChannel.send({
                type: 'broadcast',
                event: 'webrtc_signal',
                payload: { type: 'offer', sdp: peerConnection.localDescription, senderSlot: localPlayer.slot }
              });
            }
          })
          .catch((err) => console.warn('WebRTC Offer error:', err));
      } else {
        peerConnection.ondatachannel = (event) => {
          dataChannel = event.channel;
          this._bindDataChannel(dataChannel);
        };
      }
    },

    _bindDataChannel(dc) {
      dc.onopen = () => {
        p2pActive = true;
        console.log('⚡ WebRTC P2P DataChannel connected!');
        if (userCallbacks.onP2PConnected) userCallbacks.onP2PConnected();
      };
      dc.onclose = () => {
        p2pActive = false;
        console.log('WebRTC DataChannel closed - fallback to Supabase broadcast');
      };
      dc.onerror = (err) => {
        console.warn('WebRTC DataChannel error:', err);
      };
      dc.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (userCallbacks.onBroadcastEvent) userCallbacks.onBroadcastEvent(payload);
        } catch (e) {
          console.error('DataChannel parse error:', e);
        }
      };
    },

    _handleSignal(signal) {
      if (!peerConnection || signal.senderSlot === localPlayer.slot) return;

      if (signal.type === 'offer' && !localPlayer.isHost) {
        peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp))
          .then(() => peerConnection.createAnswer())
          .then((answer) => peerConnection.setLocalDescription(answer))
          .then(() => {
            if (activeChannel) {
              activeChannel.send({
                type: 'broadcast',
                event: 'webrtc_signal',
                payload: { type: 'answer', sdp: peerConnection.localDescription, senderSlot: localPlayer.slot }
              });
            }
          })
          .catch((err) => console.warn('WebRTC Answer error:', err));
      } else if (signal.type === 'answer' && localPlayer.isHost) {
        peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp))
          .catch((err) => console.warn('WebRTC setRemote error:', err));
      } else if (signal.type === 'ice') {
        peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate))
          .catch((err) => console.warn('WebRTC addIce error:', err));
      }
    },

    subscribeToRoom(roomCode, callbacks = {}) {
      const client = initClient();
      if (!client) return;

      userCallbacks = callbacks;

      if (activeChannel) {
        client.removeChannel(activeChannel);
      }

      activeChannel = client.channel(`room:${roomCode}`, {
        config: { broadcast: { self: false } }
      });

      activeChannel
        .on('broadcast', { event: 'game_event' }, (payload) => {
          // If we receive over Supabase and P2P is not delivering, handle it
          if (callbacks.onBroadcastEvent) callbacks.onBroadcastEvent(payload.payload);
        })
        .on('broadcast', { event: 'webrtc_signal' }, (payload) => {
          this._handleSignal(payload.payload);
        })
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'game_rooms',
          filter: `room_code=eq.${roomCode}`
        }, (payload) => {
          currentRoom = payload.new;
          if (callbacks.onRoomUpdate) callbacks.onRoomUpdate(payload.new);
          if (payload.new.status === 'playing' && !peerConnection) {
            this._setupWebRTC(localPlayer.isHost);
          }
        })
        .subscribe((status) => {
          if (callbacks.onSubscribeStatus) callbacks.onSubscribeStatus(status);
          if (status === 'SUBSCRIBED' && currentRoom && currentRoom.status === 'playing') {
            this._setupWebRTC(localPlayer.isHost);
          }
        });

      return activeChannel;
    },

    sendEvent(eventType, payload = {}) {
      const data = { eventType, sender: localPlayer, ...payload };
      let sentP2P = false;

      if (dataChannel && dataChannel.readyState === 'open') {
        try {
          dataChannel.send(JSON.stringify(data));
          sentP2P = true;
        } catch (e) {
          sentP2P = false;
        }
      }

      // Always send or mirror critical game lifecycle events to Supabase Realtime broadcast
      const isCriticalEvent = !sentP2P || eventType.startsWith('init_') || eventType.includes('rematch') || eventType.includes('ready') || eventType === 'game_over';
      if (isCriticalEvent && activeChannel) {
        activeChannel.send({
          type: 'broadcast',
          event: 'game_event',
          payload: data
        });
      }
    },

    async leaveRoom() {
      if (peerConnection) {
        try { peerConnection.close(); } catch (e) {}
        peerConnection = null;
      }
      dataChannel = null;
      p2pActive = false;

      if (activeChannel && supabaseClient) {
        supabaseClient.removeChannel(activeChannel);
        activeChannel = null;
      }
      currentRoom = null;
    },

    // --- Standardized Turn Draw Roulette Runner ---
    runTurnDraw(options = {}) {
      const hostName = (options.hostName || currentRoom?.host_name || 'Player 1').toUpperCase();
      const guestName = (options.guestName || currentRoom?.guest_name || 'Player 2').toUpperCase();
      const firstTurn = options.firstTurn || (Math.random() < 0.5 ? 1 : 2);
      const mySlot = options.mySlot || localPlayer.slot || 1;
      const onComplete = options.onComplete || (() => {});

      let overlay = document.getElementById('turn-draw-overlay');
      if (!overlay) {
        this.injectTurnDrawHTML();
        overlay = document.getElementById('turn-draw-overlay');
      }

      const badge = document.getElementById('turn-draw-badge');
      const title = document.getElementById('turn-draw-title');
      const sub = document.getElementById('turn-draw-sub');
      const result = document.getElementById('turn-draw-result');

      overlay.classList.add('active');
      badge.classList.add('spinning');
      badge.textContent = '🎰';
      title.textContent = 'DRAWING FIRST TURN...';
      sub.textContent = `${hostName} VS ${guestName}`;
      result.style.display = 'none';

      setTimeout(() => {
        badge.classList.remove('spinning');
        const isP1 = firstTurn === 1;
        const winnerName = isP1 ? hostName : guestName;
        badge.textContent = isP1 ? '🔵' : '🔴';
        title.textContent = `${winnerName} THROWS FIRST!`;
        sub.textContent = 'Turn draw complete';

        const isMyTurn = (firstTurn === mySlot);
        result.style.display = 'block';
        result.style.background = isP1 ? '#38bdf8' : '#ec4899';
        result.style.color = '#ffffff';
        result.textContent = isMyTurn ? '⚡ YOUR TURN FIRST!' : "⌛ OPPONENT'S TURN FIRST!";

        setTimeout(() => {
          overlay.classList.remove('active');
          onComplete(firstTurn);
        }, 1600);
      }, 1400);
    },

    injectTurnDrawHTML() {
      if (document.getElementById('turn-draw-overlay')) return;
      const el = document.createElement('div');
      el.id = 'turn-draw-overlay';
      el.className = 'turn-draw-overlay';
      el.innerHTML = `
        <div class="turn-draw-card">
          <div id="turn-draw-badge" class="turn-draw-badge spinning">🎰</div>
          <h2 id="turn-draw-title" class="turn-draw-title">DRAWING FIRST TURN...</h2>
          <p id="turn-draw-sub" style="font-size: 14px; font-weight: 700; color: #94a3b8; margin: 0 0 16px 0;">Selecting starting player</p>
          <div id="turn-draw-result" class="turn-draw-result"></div>
        </div>
      `;
      document.body.appendChild(el);
    },

    injectStyles() {
      if (document.getElementById('supabase-mp-styles')) return;
      const style = document.createElement('style');
      style.id = 'supabase-mp-styles';
      style.innerHTML = `
        .mp-modal-overlay {
          position: fixed;
          inset: 0;
          z-index: 99999;
          background: rgba(15, 23, 42, 0.88);
          backdrop-filter: blur(10px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          animation: mpFadeIn 0.25s ease;
        }

        @keyframes mpFadeIn {
          from { opacity: 0; transform: scale(0.96); }
          to { opacity: 1; transform: scale(1); }
        }

        .mp-modal-card {
          width: 100%;
          max-width: 440px;
          background: #1e293b;
          border: 4px solid #000000;
          border-radius: 28px;
          padding: 24px;
          box-shadow: 0 12px 0 #000000, 0 20px 40px rgba(0,0,0,0.5);
          color: #ffffff;
          font-family: 'Fredoka', 'Outfit', system-ui, sans-serif;
          position: relative;
        }

        .mp-close-btn {
          position: absolute;
          top: 16px;
          right: 16px;
          width: 36px;
          height: 36px;
          background: #334155;
          border: 3px solid #000000;
          border-radius: 12px;
          color: #fff;
          font-weight: 900;
          font-size: 18px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .mp-title {
          font-size: 24px;
          font-weight: 900;
          text-align: center;
          color: #38bdf8;
          text-shadow: 0 2px 0 #000;
          margin-bottom: 6px;
        }

        .mp-subtitle {
          font-size: 14px;
          text-align: center;
          color: #94a3b8;
          margin-bottom: 20px;
        }

        .mp-btn {
          width: 100%;
          padding: 14px 20px;
          font-size: 16px;
          font-weight: 900;
          border: 3px solid #000000;
          border-radius: 18px;
          cursor: pointer;
          margin-bottom: 12px;
          box-shadow: 0 4px 0 #000000;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          transition: transform 0.1s ease, box-shadow 0.1s ease;
          font-family: inherit;
        }

        .mp-btn:active {
          transform: translateY(2px);
          box-shadow: 0 2px 0 #000000;
        }

        .mp-btn-primary { background: linear-gradient(135deg, #38bdf8, #0284c7); color: #fff; }
        .mp-btn-success { background: linear-gradient(135deg, #22c55e, #15803d); color: #fff; }
        .mp-btn-purple { background: linear-gradient(135deg, #a855f7, #7e22ce); color: #fff; }
        .mp-btn-outline { background: #334155; color: #fff; }

        .mp-input {
          width: 100%;
          padding: 14px;
          font-size: 18px;
          font-weight: 800;
          text-align: center;
          letter-spacing: 2px;
          background: #0f172a;
          border: 3px solid #000000;
          border-radius: 16px;
          color: #f8fafc;
          margin-bottom: 12px;
          outline: none;
          font-family: inherit;
          text-transform: uppercase;
        }

        .mp-code-box {
          background: #0f172a;
          border: 3px dashed #38bdf8;
          border-radius: 16px;
          padding: 16px;
          text-align: center;
          margin: 14px 0;
        }

        .mp-code-text {
          font-size: 32px;
          font-weight: 900;
          letter-spacing: 6px;
          color: #facc15;
          text-shadow: 0 2px 0 #000;
        }

        .mp-status-badge {
          display: inline-block;
          padding: 6px 14px;
          border-radius: 20px;
          background: #0369a1;
          color: #e0f2fe;
          font-size: 13px;
          font-weight: 800;
          margin-top: 8px;
        }

        /* Turn Draw Roulette Overlay */
        .turn-draw-overlay {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.92);
          backdrop-filter: blur(12px);
          z-index: 100000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.3s ease;
        }
        .turn-draw-overlay.active {
          opacity: 1;
          pointer-events: all;
        }
        .turn-draw-card {
          background: #1e293b;
          border: 4px solid #000000;
          border-radius: 32px;
          padding: 32px 28px;
          text-align: center;
          max-width: 380px;
          width: 100%;
          box-shadow: 0 16px 0 #000000, 0 25px 50px rgba(0, 0, 0, 0.5);
          animation: drawPopIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
          color: #ffffff;
          font-family: 'Fredoka', 'Outfit', system-ui, sans-serif;
        }
        @keyframes drawPopIn {
          from { transform: scale(0.7); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .turn-draw-badge {
          font-size: 64px;
          margin-bottom: 12px;
          display: inline-block;
        }
        .turn-draw-badge.spinning {
          animation: drawSpin 0.25s linear infinite;
        }
        @keyframes drawSpin {
          0% { transform: rotate(0deg) scale(1); }
          50% { transform: rotate(180deg) scale(1.15); }
          100% { transform: rotate(360deg) scale(1); }
        }
        .turn-draw-title {
          font-size: 24px;
          font-weight: 900;
          color: #facc15;
          text-shadow: 0 2px 0 #000000;
          margin: 0 0 8px 0;
          text-transform: uppercase;
        }
        .turn-draw-result {
          display: none;
          margin-top: 14px;
          padding: 12px 18px;
          border-radius: 16px;
          border: 3px solid #000000;
          font-size: 16px;
          font-weight: 900;
          box-shadow: 0 4px 0 #000000;
          animation: drawResultPop 0.3s ease;
        }
        @keyframes drawResultPop {
          from { transform: scale(0.85); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    },

    renderUI(gameId, gameTitle, onStartMultiplayer) {
      this.injectStyles();
      this.injectTurnDrawHTML();

      let modalEl = document.getElementById('supabase-mp-modal');
      if (modalEl) modalEl.remove();

      modalEl = document.createElement('div');
      modalEl.id = 'supabase-mp-modal';
      modalEl.className = 'mp-modal-overlay';

      const renderView = (viewType, extraData = {}) => {
        let contentHtml = '';

        if (viewType === 'main') {
          contentHtml = `
            <div class="mp-title">🌐 REALTIME ONLINE</div>
            <div class="mp-subtitle">Play ${gameTitle} vs Anyone Worldwide</div>

            <input type="text" id="mp-name-input" class="mp-input" style="letter-spacing: normal; text-transform: none;" placeholder="Enter Your Nickname" value="${localStorage.getItem('arcade_player_name') || 'Player' + Math.floor(Math.random()*899+100)}">

            <button class="mp-btn mp-btn-primary" id="mp-quick-btn">⚡ QUICK MATCH</button>
            <button class="mp-btn mp-btn-success" id="mp-create-btn">➕ CREATE ROOM</button>
            <button class="mp-btn mp-btn-purple" id="mp-join-btn">🔑 JOIN WITH CODE</button>
          `;
        } else if (viewType === 'create') {
          contentHtml = `
            <div class="mp-title">🎉 ROOM CREATED</div>
            <div class="mp-subtitle">Share this code with your friend</div>

            <div class="mp-code-box">
              <div class="mp-code-text">${extraData.roomCode}</div>
              <div class="mp-status-badge">⌛ WAITING FOR OPPONENT...</div>
            </div>

            <button class="mp-btn mp-btn-outline" id="mp-copy-btn">📋 COPY ROOM CODE</button>
            <button class="mp-btn mp-btn-purple" id="mp-cancel-btn">❌ CANCEL ROOM</button>
          `;
        } else if (viewType === 'join') {
          contentHtml = `
            <div class="mp-title">🔑 JOIN ROOM</div>
            <div class="mp-subtitle">Enter 5-character Room Code</div>

            <input type="text" id="mp-code-input" class="mp-input" placeholder="ROOM CODE" maxlength="6">

            <button class="mp-btn mp-btn-success" id="mp-submit-join">🚀 ENTER MATCH</button>
            <button class="mp-btn mp-btn-outline" id="mp-back-btn">⬅️ BACK</button>
          `;
        }

        modalEl.innerHTML = `
          <div class="mp-modal-card">
            <button class="mp-close-btn" onclick="document.getElementById('supabase-mp-modal').remove()">✕</button>
            ${contentHtml}
          </div>
        `;

        // Bind Events
        if (viewType === 'main') {
          const nameInput = modalEl.querySelector('#mp-name-input');

          modalEl.querySelector('#mp-quick-btn').onclick = async () => {
            const name = nameInput.value.trim() || 'Player';
            localStorage.setItem('arcade_player_name', name);
            try {
              modalEl.querySelector('#mp-quick-btn').textContent = '⌛ CONNECTING...';
              const res = await SupabaseMultiplayer.quickMatch(gameId, name);
              if (res.room.status === 'playing') {
                modalEl.remove();
                onStartMultiplayer(res.room, res.player);
              } else {
                renderView('create', { roomCode: res.room.room_code });
                SupabaseMultiplayer.subscribeToRoom(res.room.room_code, {
                  onRoomUpdate: (room) => {
                    if (room.status === 'playing') {
                      modalEl.remove();
                      onStartMultiplayer(room, res.player);
                    }
                  }
                });
              }
            } catch (err) {
              alert(err.message || 'Matchmaking error!');
              renderView('main');
            }
          };

          modalEl.querySelector('#mp-create-btn').onclick = async () => {
            const name = nameInput.value.trim() || 'Player';
            localStorage.setItem('arcade_player_name', name);
            try {
              const res = await SupabaseMultiplayer.createRoom(gameId, name);
              renderView('create', { roomCode: res.room.room_code });

              SupabaseMultiplayer.subscribeToRoom(res.room.room_code, {
                onRoomUpdate: (room) => {
                  if (room.status === 'playing') {
                    modalEl.remove();
                    onStartMultiplayer(room, res.player);
                  }
                }
              });
            } catch (err) {
              alert(err.message || 'Could not create room');
            }
          };

          modalEl.querySelector('#mp-join-btn').onclick = () => renderView('join');
        } else if (viewType === 'create') {
          modalEl.querySelector('#mp-copy-btn').onclick = () => {
            navigator.clipboard.writeText(extraData.roomCode);
            alert('Room code copied to clipboard!');
          };
          modalEl.querySelector('#mp-cancel-btn').onclick = () => {
            SupabaseMultiplayer.leaveRoom();
            renderView('main');
          };
        } else if (viewType === 'join') {
          modalEl.querySelector('#mp-back-btn').onclick = () => renderView('main');
          modalEl.querySelector('#mp-submit-join').onclick = async () => {
            const code = modalEl.querySelector('#mp-code-input').value;
            const name = localStorage.getItem('arcade_player_name') || 'Guest';
            if (!code || code.length < 4) {
              alert('Please enter a valid room code');
              return;
            }
            try {
              const res = await SupabaseMultiplayer.joinRoom(code, name);
              modalEl.remove();
              onStartMultiplayer(res.room, res.player);
            } catch (err) {
              alert(err.message || 'Failed to join room');
            }
          };
        }
      };

      renderView('main');
      document.body.appendChild(modalEl);
    }
  };

  window.SupabaseMultiplayer = SupabaseMultiplayer;
})(window);
