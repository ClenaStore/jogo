(() => {
  const $ = sel => document.querySelector(sel);
  const fmt = v => (Number(v)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const saldoEl = $('#saldo');
  const betEl = $('#bet');
  const autoEl = $('#auto');
  const autoVal = $('#autoVal');
  const startBtn = $('#start');
  const cashBtn = $('#cash');
  const statusEl = $('#status');
  const multEl = $('#mult');
  const historyEl = $('#history');
  const planeEl = $('#plane');
  const skyEl = $('#sky');
  const chatBox = $('#chat');
  const chatForm = $('#chatForm');
  const chatInput = $('#chatInput');
  const betsBox = $('#bets');
  const canvas = document.getElementById('fx');
  const ctx = canvas.getContext('2d');

  function resize(){ canvas.width = skyEl.clientWidth; canvas.height = skyEl.clientHeight; }
  addEventListener('resize', resize, {passive:true}); resize();

  let nick = localStorage.getItem('nick');
  if (!nick){
    nick = (prompt('Escolha seu apelido:')||'Convidado').slice(0,24).trim();
    localStorage.setItem('nick', nick);
  }

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${wsProto}://${location.host}`);

  let hasOpenBet = false;
  autoVal.textContent = Number(autoEl.value).toFixed(2);

  ws.addEventListener('open', () => {
    send('hello', { nick });
  });

  ws.addEventListener('message', (ev) => {
    const { type, payload } = JSON.parse(ev.data);
    if (type === 'welcome'){
      saldoEl.textContent = fmt(payload.user.balance);
      payload.chat.forEach(addChat);
      payload.history.forEach(h => addTag(h.crashAt));
      return;
    }
    if (type === 'chat'){ addChat(payload); return; }
    if (type === 'bet'){
      addBet(payload);
      if (payload.nick === nick){ hasOpenBet = true; cashBtn.disabled = false; startBtn.disabled = true; }
      return;
    }
    if (type === 'balance'){ saldoEl.textContent = fmt(payload.balance); return; }
    if (type === 'roundStart'){
      statusEl.textContent = 'Rodada iniciada'; statusEl.className='status';
      multEl.innerHTML = '1.00x <small>rodando…</small>';
      if (!hasOpenBet){ startBtn.disabled = false; }
      return;
    }
    if (type === 'tick'){
      multEl.innerHTML = `${Number(payload.mult).toFixed(2)}x <small>ao vivo</small>`;
      animatePlane(Number(payload.mult));
      return;
    }
    if (type === 'roundCrash'){
      statusEl.textContent = 'Crash!'; statusEl.className='status crashed';
      multEl.innerHTML = `${Number(payload.crashAt).toFixed(2)}x <small>o avião caiu</small>`;
      addTag(payload.crashAt);
      hasOpenBet = false;
      cashBtn.disabled = true; startBtn.disabled = false;
      return;
    }
    if (type === 'cashout'){
      if (payload.nick === nick){
        hasOpenBet = false;
        cashBtn.disabled = true; startBtn.disabled = false;
      }
      return;
    }
    if (type === 'notice'){
      // errors/avisos simples
      addChat({nick:'sistema', text:payload.message, type:'system'});
      return;
    }
  });

  function send(type, payload){ ws.readyState === 1 && ws.send(JSON.stringify({ type, payload })); }

  // Chat
  function addChat({ nick, text, type }){
    const div = document.createElement('div');
    div.className = 'msg' + (type==='system'?' sys':'');
    const safe = String(text).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;','\'':'&#39;'}[c]));
    div.innerHTML = `<span class="nick">${nick}</span>: ${safe}`;
    chatBox.appendChild(div); chatBox.scrollTop = chatBox.scrollHeight;
  }
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault(); const text = chatInput.value.trim(); if(!text) return;
    send('chat', { text }); chatInput.value='';
  });

  function addBet({ nick, amount, auto }){
    const row = document.createElement('div'); row.className='row';
    row.innerHTML = `<div class="who">${nick}</div><div class="amt">${fmt(amount)} • ${Number(auto).toFixed(2)}x</div>`;
    betsBox.prepend(row);
    if (betsBox.children.length > 50) betsBox.removeChild(betsBox.lastChild);
  }

  // UI aposta
  autoEl.addEventListener('input', ()=>{ autoVal.textContent = Number(autoEl.value).toFixed(2); });
  document.querySelectorAll('.btn-mini').forEach(b=> b.addEventListener('click', () => {
    const step = Number(b.dataset.step||0);
    if (b.id==='max') betEl.value = 100000;
    else betEl.value = Math.max(1, Math.floor((Number(betEl.value)||0) + step));
  }));

  startBtn.addEventListener('click', ()=>{
    const amount = Math.max(1, Math.floor(Number(betEl.value)||0));
    const auto = Math.max(1.1, Number(autoEl.value));
    send('placeBet', { amount, auto });
  });

  cashBtn.addEventListener('click', ()=>{ send('cashout', {}); });

  // Animações
  function animatePlane(mult){
    const progress = Math.min(1, (mult-1)/9);
    const x = progress * (skyEl.clientWidth - 120);
    const y = Math.sin(progress*2.2) * 14;
    const tilt = Math.min(22, progress*28);
    planeEl.style.transform = `translate(${x}px, ${-y}px) rotate(${tilt}deg)`;
    drawFx();
  }
  let particles=[]; const gravity=.12;
  function drawFx(){ ctx.clearRect(0,0,canvas.width,canvas.height); particles = particles.filter(p=>p.life>0); particles.forEach(p=>{ p.life--; p.x+=p.vx; p.y+=p.vy; p.vy+=gravity; ctx.globalAlpha = Math.max(0, p.life/100); ctx.fillStyle = p.c || '#fff'; ctx.fillRect(p.x, p.y, 3, 3); ctx.globalAlpha = 1; }); }
})();