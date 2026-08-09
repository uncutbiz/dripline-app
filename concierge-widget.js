// concierge-widget.js
// DRIPLINE Booking Concierge — embeddable chat widget
//
// Add to your frontend (uncutbiz/dripline-app) right before </body>:
//   <script>window.DRIPLINE_BACKEND_URL = "https://dripline-backend-1.onrender.com";</script>
//   <script src="concierge-widget.js"></script>
//
// No dependencies. Self-injects its own styles and DOM.

(function () {
  const BACKEND_URL = window.DRIPLINE_BACKEND_URL || 'https://dripline-backend-1.onrender.com';
  const ENDPOINT = `${BACKEND_URL}/api/concierge/message`;

  const STYLE = `
    #dl-concierge * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif; }
    #dl-concierge {
      --dl-navy: #0B1E33;
      --dl-saline: #2FB6DB;
      --dl-vital: #FF6B52;
      --dl-mist: #EEF5F8;
      --dl-ink: #14212E;
      --dl-line: #D7E4EA;
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
    }
    #dl-launcher {
      width: 60px; height: 60px; border-radius: 50%;
      background: var(--dl-navy); border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 6px 20px rgba(11,30,51,0.35);
      transition: transform 0.15s ease;
    }
    #dl-launcher:hover { transform: scale(1.06); }
    #dl-launcher svg { width: 26px; height: 26px; }
    #dl-panel {
      display: none; flex-direction: column;
      position: absolute; bottom: 74px; right: 0;
      width: 340px; max-width: calc(100vw - 40px); height: 480px; max-height: 70vh;
      background: #fff; border-radius: 16px; overflow: hidden;
      box-shadow: 0 12px 40px rgba(11,30,51,0.25);
      border: 1px solid var(--dl-line);
    }
    #dl-panel.open { display: flex; }
    #dl-header {
      background: var(--dl-navy); color: #fff; padding: 14px 16px;
      display: flex; align-items: center; justify-content: space-between;
    }
    #dl-header .title { font-weight: 700; font-size: 15px; letter-spacing: 0.2px; }
    #dl-header .sub { font-size: 11px; color: var(--dl-saline); margin-top: 2px; }
    #dl-close { background: none; border: none; color: #fff; opacity: 0.7; cursor: pointer; font-size: 18px; line-height: 1; }
    #dl-close:hover { opacity: 1; }
    #dl-messages {
      flex: 1; overflow-y: auto; padding: 14px; background: var(--dl-mist);
      display: flex; flex-direction: column; gap: 10px;
    }
    .dl-msg { max-width: 84%; padding: 9px 12px; border-radius: 14px; font-size: 13.5px; line-height: 1.4; white-space: pre-wrap; }
    .dl-msg.bot { background: #fff; color: var(--dl-ink); border: 1px solid var(--dl-line); align-self: flex-start; border-bottom-left-radius: 4px; }
    .dl-msg.user { background: var(--dl-navy); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
    .dl-msg a.dl-checkout {
      display: inline-block; margin-top: 8px; background: var(--dl-vital); color: #fff;
      padding: 8px 14px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 13px;
    }
    #dl-typing { align-self: flex-start; display: flex; align-items: center; gap: 6px; padding: 4px 2px; }
    .dl-drop { width: 8px; height: 10px; background: var(--dl-saline); border-radius: 50% 50% 50% 0; transform: rotate(45deg); animation: dl-pulse 1s infinite ease-in-out; }
    .dl-drop:nth-child(2) { animation-delay: 0.15s; }
    .dl-drop:nth-child(3) { animation-delay: 0.3s; }
    @keyframes dl-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
    #dl-inputrow { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--dl-line); background: #fff; }
    #dl-input {
      flex: 1; border: 1px solid var(--dl-line); border-radius: 20px; padding: 9px 14px;
      font-size: 13.5px; outline: none;
    }
    #dl-input:focus { border-color: var(--dl-saline); }
    #dl-send {
      background: var(--dl-vital); border: none; color: #fff; width: 36px; height: 36px;
      border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    #dl-send:disabled { opacity: 0.5; cursor: default; }
  `;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    children.forEach((c) => node.appendChild(c));
    return node;
  }

  function init() {
    const styleTag = document.createElement('style');
    styleTag.textContent = STYLE;
    document.head.appendChild(styleTag);

    const root = el('div', { id: 'dl-concierge' });

    const launcher = el('button', { id: 'dl-launcher', innerHTML: dropSvg() });
    const panel = el('div', { id: 'dl-panel' });

    const header = el('div', { id: 'dl-header' });
    header.innerHTML = `<div><div class="title">DRIPLINE</div><div class="sub">Book a drip — usually replies instantly</div></div>`;
    const closeBtn = el('button', { id: 'dl-close', innerHTML: '&times;' });
    header.appendChild(closeBtn);

    const messages = el('div', { id: 'dl-messages' });

    const inputRow = el('div', { id: 'dl-inputrow' });
    const input = el('input', { id: 'dl-input', placeholder: 'What do you need today?' });
    const sendBtn = el('button', { id: 'dl-send', innerHTML: sendSvg() });
    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);

    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(inputRow);
    root.appendChild(panel);
    root.appendChild(launcher);
    document.body.appendChild(root);

    let sessionId = null;
    let open = false;

    launcher.addEventListener('click', () => {
      open = !open;
      panel.classList.toggle('open', open);
      if (open && messages.children.length === 0) {
        addBotMessage("Hey — I'm the DRIPLINE concierge. Hangover, workout recovery, or just feeling run down? Tell me what's up and I'll get you sorted.");
      }
    });
    closeBtn.addEventListener('click', () => {
      open = false;
      panel.classList.remove('open');
    });

    function addMessage(text, sender) {
      const msg = el('div', { className: `dl-msg ${sender}` });
      msg.innerHTML = linkify(text);
      messages.appendChild(msg);
      messages.scrollTop = messages.scrollHeight;
    }
    function addBotMessage(text) { addMessage(text, 'bot'); }

    function linkify(text) {
      // turn any stripe checkout URL into a styled button, escape everything else minimally
      const escaped = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return escaped.replace(
        /(https?:\/\/checkout\.stripe\.com\S+)/g,
        '<br/><a class="dl-checkout" href="$1" target="_blank" rel="noopener">Pay & Confirm Booking →</a>'
      );
    }

    function showTyping() {
      const t = el('div', { id: 'dl-typing' });
      t.innerHTML = '<span class="dl-drop"></span><span class="dl-drop"></span><span class="dl-drop"></span>';
      messages.appendChild(t);
      messages.scrollTop = messages.scrollHeight;
      return t;
    }

    async function send() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendBtn.disabled = true;
      addMessage(text, 'user');
      const typingEl = showTyping();

      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, message: text })
        });
        const data = await res.json();
        typingEl.remove();
        if (data.sessionId) sessionId = data.sessionId;
        let reply = data.reply || "Sorry, I didn't catch that — mind trying again?";
        if (data.checkoutUrl) reply += `\n${data.checkoutUrl}`;
        addBotMessage(reply);
      } catch (err) {
        typingEl.remove();
        addBotMessage("I'm having trouble connecting right now — you can also text or call us directly.");
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }

  function dropSvg() {
    return `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2C12 2 5 11 5 15.5C5 19.09 8.13 22 12 22C15.87 22 19 19.09 19 15.5C19 11 12 2 12 2Z" fill="#2FB6DB"/></svg>`;
  }
  function sendSvg() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 12L20 4L14 20L11 13L4 12Z" fill="#fff"/></svg>`;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
