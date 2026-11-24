/* Adaptador: misma API que usa el CRM (collection().onSnapshot/add/doc().update/set/delete)
   sobre una tabla de Supabase "docs" (collection, id, data jsonb). Incluye inicio de sesión. */
(function(){
  const cfg=window.CRM_CONFIG||{};
  // Invitación o recuperación: el enlace del correo trae type=invite|recovery en la URL
  const flow=(/type=(invite|recovery)/.exec(location.hash+location.search)||[])[1]||null;
  const sb=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
  window.__sb=sb;
  const rid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
  function snap(rows){return{docs:rows.map(r=>({id:r.id,data:()=>r.data})),metadata:{fromCache:false}}}
  function collection(name){
    return{
      onSnapshot(cb,err){
        let alive=true;
        const load=async()=>{const{data,error}=await sb.from('docs').select('id,data').eq('collection',name);
          if(!alive)return;if(error){err&&err(error);return}cb(snap(data||[]))};
        load();
        const ch=sb.channel('docs-'+name+'-'+rid()).on('postgres_changes',{event:'*',schema:'public',table:'docs',filter:'collection=eq.'+name},()=>load()).subscribe();
        document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
        return()=>{alive=false;sb.removeChannel(ch)};
      },
      async add(data){const id=rid();const{error}=await sb.from('docs').insert({collection:name,id,data});if(error)throw error;return{id}},
      doc(id){return{
        async set(data){const{error}=await sb.from('docs').upsert({collection:name,id,data,updated_at:new Date().toISOString()});if(error)throw error},
        async update(patch){const{data:row,error:e1}=await sb.from('docs').select('data').eq('collection',name).eq('id',id).single();if(e1)throw e1;
          const merged={...(row?row.data:{}),...patch};
          const{error}=await sb.from('docs').update({data:merged,updated_at:new Date().toISOString()}).eq('collection',name).eq('id',id);if(error)throw error},
        async delete(){const{error}=await sb.from('docs').delete().eq('collection',name).eq('id',id);if(error)throw error}
      }}
    };
  }
  const db={collection};
  // Pantalla de inicio de sesión
  let ready;const sessionReady=new Promise(r=>ready=r);
  function loginUI(){
    const o=document.createElement('div');o.id='login';
    o.innerHTML=`<form><h1>CRM de Luisa</h1><p>Ingresa con tu correo y contraseña.</p>
      <input type="email" name="e" placeholder="Correo" required autocomplete="username">
      <input type="password" name="p" placeholder="Contraseña" required autocomplete="current-password">
      <button class="btn primary" type="submit">Entrar</button>
      <button class="btn small" type="button" id="olvide">¿Olvidaste tu contraseña?</button><div class="err" role="alert"></div></form>`;
    const st=document.createElement('style');st.textContent=`#login{position:fixed;inset:0;background:#fff;display:grid;place-items:center;z-index:9999;padding:16px}
      #login form{width:100%;max-width:340px;display:grid;gap:10px}#login h1{font:700 24px 'Plus Jakarta Sans',sans-serif;margin:0}
      #login p{margin:0 0 6px;color:#68707a}#login #olvide{border:0;background:none;color:#68707a;font-size:13px;text-decoration:underline;cursor:pointer;justify-self:start;padding:0}#login .err{color:#e5484d;font-size:13px;min-height:18px}`;
    document.head.append(st);document.body.append(o);
    o.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.target;const btn=f.querySelector('button');btn.disabled=true;
      const{error}=await sb.auth.signInWithPassword({email:f.e.value.trim(),password:f.p.value});btn.disabled=false;
      if(error){o.querySelector('.err').textContent='Correo o contraseña incorrectos.';return}o.remove();ready()};
    o.querySelector('#olvide').onclick=async()=>{const em=o.querySelector('input[name=e]').value.trim();const msg=o.querySelector('.err');
      if(!em){msg.textContent='Escribe tu correo arriba y vuelve a tocar aquí.';return}
      await sb.auth.resetPasswordForEmail(em,{redirectTo:location.origin+location.pathname});
      msg.style.color='#1b1f24';msg.textContent='Si ese correo tiene acceso, te llegó un enlace para crear una contraseña nueva.'};
  }
  function setPassUI(){
    const o=document.createElement('div');o.id='login';
    o.innerHTML=`<form><h1>Crea tu contraseña</h1><p>Es la que usarás para entrar al CRM.</p>
      <input type="password" name="p" placeholder="Contraseña nueva (mínimo 8)" minlength="8" required autocomplete="new-password">
      <input type="password" name="q" placeholder="Repítela" minlength="8" required autocomplete="new-password">
      <button class="btn primary" type="submit">Guardar y entrar</button><div class="err" role="alert"></div></form>`;
    document.body.append(o);
    o.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.target;const err=o.querySelector('.err');
      if(f.p.value!==f.q.value){err.textContent='Las contraseñas no coinciden.';return}
      const{error}=await sb.auth.updateUser({password:f.p.value});
      if(error){err.textContent='No se pudo guardar: '+error.message;return}
      history.replaceState(null,'',location.pathname);o.remove();ready()};
  }
  const whenBody=f=>document.body?f():document.addEventListener('DOMContentLoaded',f);
  let recovering=false;
  sb.auth.onAuthStateChange(ev=>{if(ev==='PASSWORD_RECOVERY'&&!recovering){recovering=true;whenBody(()=>{document.getElementById('login')?.remove();setPassUI()})}});
  sb.auth.getSession().then(({data})=>{if(recovering)return;
    if(data.session&&flow){recovering=true;whenBody(setPassUI)}
    else if(data.session)ready();else whenBody(loginUI)});
  window.crmLogout=async()=>{await sb.auth.signOut();location.reload()};
  window.claude={async use(n){if(n==='db'){await sessionReady;return db}if(n==='user')return{can:async()=>true};return null}};
})();
