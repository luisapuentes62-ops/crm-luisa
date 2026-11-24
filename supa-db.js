/* Adaptador: misma API que usa el CRM (collection().onSnapshot/add/doc().update/set/delete)
   sobre una tabla de Supabase "docs" (collection, id, data jsonb). Incluye inicio de sesión. */
(function(){
  const cfg=window.CRM_CONFIG||{};
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
      <button class="btn primary" type="submit">Entrar</button><div class="err" role="alert"></div></form>`;
    const st=document.createElement('style');st.textContent=`#login{position:fixed;inset:0;background:#fff;display:grid;place-items:center;z-index:9999;padding:16px}
      #login form{width:100%;max-width:340px;display:grid;gap:10px}#login h1{font:700 24px 'Plus Jakarta Sans',sans-serif;margin:0}
      #login p{margin:0 0 6px;color:#68707a}#login .err{color:#e5484d;font-size:13px;min-height:18px}`;
    document.head.append(st);document.body.append(o);
    o.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.target;const btn=f.querySelector('button');btn.disabled=true;
      const{error}=await sb.auth.signInWithPassword({email:f.e.value.trim(),password:f.p.value});btn.disabled=false;
      if(error){o.querySelector('.err').textContent='Correo o contraseña incorrectos.';return}o.remove();ready()};
  }
  sb.auth.getSession().then(({data})=>{if(data.session)ready();else if(document.body)loginUI();else document.addEventListener('DOMContentLoaded',loginUI)});
  window.crmLogout=async()=>{await sb.auth.signOut();location.reload()};
  window.claude={async use(n){if(n==='db'){await sessionReady;return db}if(n==='user')return{can:async()=>true};return null}};
})();
