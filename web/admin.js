(() => {
  const $ = sel => document.querySelector(sel);
  let token = '';

  function hdr(){ return { 'Content-Type':'application/json', 'X-Admin-Password': token }; }
  function fmt(v){ return (Number(v)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }

  $('#enter').addEventListener('click', async () => {
    token = $('#pw').value.trim();
    const ok = await ping();
    $('#loginStatus').textContent = ok ? 'OK' : 'Senha incorreta';
    if (ok) listUsers();
  });

  async function ping(){
    try{
      const r = await fetch('/api/admin/ping', { headers: hdr() });
      return r.ok;
    }catch{ return false; }
  }

  async function listUsers(){
    const r = await fetch('/api/admin/users', { headers: hdr() });
    if (!r.ok){ $('#users').textContent = 'Erro ao listar.'; return; }
    const data = await r.json();
    const box = $('#users'); box.innerHTML='';
    data.users.forEach(u => {
      const row = document.createElement('div'); row.className='row';
      row.innerHTML = `<div>${u.nick} <span class="tag ${u.blocked?'blocked':''}">${u.blocked?'bloqueado':'ativo'}</span></div>
                       <div><b>${fmt(u.balance)}</b></div>`;
      box.appendChild(row);
    });
  }

  $('#createUser').addEventListener('click', async ()=>{
    const nick = $('#newNick').value.trim(); if (!nick) return alert('Informe o apelido');
    const init = Number($('#newInit').value||0);
    const r = await fetch('/api/admin/create', { method:'POST', headers: hdr(), body: JSON.stringify({ nick, credits:init }) });
    if (r.ok){ listUsers(); $('#newNick').value=''; }
    else alert('Erro ao criar usuário');
  });

  $('#credit').addEventListener('click', ()=> adjust(+1));
  $('#debit').addEventListener('click', ()=> adjust(-1));

  async function adjust(sign){
    const nick = $('#targetNick').value.trim(); if (!nick) return alert('Informe o apelido');
    const delta = Number($('#delta').value||0) * sign;
    const r = await fetch('/api/admin/credit', { method:'POST', headers: hdr(), body: JSON.stringify({ nick, delta }) });
    if (r.ok){ listUsers(); } else alert('Falhou.');
  }

  $('#block').addEventListener('click', ()=> setBlock(true));
  $('#unblock').addEventListener('click', ()=> setBlock(false));

  async function setBlock(blocked){
    const nick = $('#blockNick').value.trim(); if (!nick) return alert('Informe o apelido');
    const r = await fetch('/api/admin/block', { method:'POST', headers: hdr(), body: JSON.stringify({ nick, blocked }) });
    if (r.ok){ listUsers(); } else alert('Falhou.');
  }
})();