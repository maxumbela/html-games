/**
 * Supabase Realtime Multiplayer Engine & UI Framework
 * Project: My first project (oxagjrukohzqmolxfluk)
 */

(function(window) {
  const SUPABASE_URL = 'https://oxagjrukohzqmolxfluk.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94YWdqcnVrb2h6cW1vbHhmbHVrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1MzgwNjMsImV4cCI6MjEwMjExNDA2M30.cu-ov8BqB5-_C43Iu-i_RoWAfypQUMnpnROIQw7-sHs';

  let supabaseClient = null;
  let activeChannel = null;
  let currentRoom = null;
  let localPlayer = { id: null, name: 'Player 1', isHost: false, slot: 1 };

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

  const SupabaseMultiplayer = {
    getUrl() { return SUPABASE_URL; },
    getAnonKey() { return SUPABASE_ANON_KEY; },
    getClient() { return initClient(); },
    getLocalPlayer() { return localPlayer; },
    getCurrentRoom() { return currentRoom; },

    async createRoom(gameId, playerName = 'Host Player') {
      const client = initClient();
      if (!client) throw new Error('Supabase client not loaded');

      const roomCode = generateRoomCode();
      const playerId = 'p_' + Math.random().toString(36).substr(2, 9);
      localPlayer = { id: playerId, name: playerName, isHost: true, slot: 1 };

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

    async joinRoom(roomCode, playerName = 'Guest Player') {
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

      const playerId = 'p_' + Math.random().toString(36).substr(2, 9);
      localPlayer = { id: playerId, name: playerName, isHost: false, slot: 2 };

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

    subscribeToRoom(roomCode, callbacks = {}) {
      const client = initClient();
      if (!client) return;

      if (activeChannel) {
        client.removeChannel(activeChannel);
      }

      activeChannel = client.channel(`room:${roomCode}`, {
        config: { broadcast: { self: false } }
      });

      activeChannel
        .on('broadcast', { event: 'game_event' }, (payload) => {
          if (callbacks.onBroadcastEvent) callbacks.onBroadcastEvent(payload.payload);
        })
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'game_rooms',
          filter: `room_code=eq.${roomCode}`
        }, (payload) => {
          currentRoom = payload.new;
          if (callbacks.onRoomUpdate) callbacks.onRoomUpdate(payload.new);
        })
        .subscribe((status) => {
          if (callbacks.onSubscribeStatus) callbacks.onSubscribeStatus(status);
        });

      return activeChannel;
    },

    sendEvent(eventType, payload = {}) {
      if (activeChannel) {
        activeChannel.send({
          type: 'broadcast',
          event: 'game_event',
          payload: { eventType, sender: localPlayer, ...payload }
        });
      }
    },

    async updateRoomState(newState) {
      const client = initClient();
      if (!client || !currentRoom) return;

      const { data, error } = await client
        .from('game_rooms')
        .update({ state: newState, updated_at: new Date().toISOString() })
        .eq('room_code', currentRoom.room_code)
        .select()
        .single();

      if (!error && data) currentRoom = data;
    },

    async leaveRoom() {
      if (activeChannel && supabaseClient) {
        supabaseClient.removeChannel(activeChannel);
        activeChannel = null;
      }
      currentRoom = null;
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
          background: rgba(15, 23, 42, 0.85);
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
      `;
      document.head.appendChild(style);
    },

    renderUI(gameId, gameTitle, onStartMultiplayer) {
      this.injectStyles();
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
