const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),url=require('url');
const root=__dirname, dataFile=path.join(root,'data.json');
const hash=(p,s=crypto.randomBytes(16).toString('hex'))=>`${s}:${crypto.scryptSync(p,s,64).toString('hex')}`;
const verify=(p,h)=>{const [s,v]=String(h).split(':');return s&&v&&crypto.timingSafeEqual(Buffer.from(v,'hex'),crypto.scryptSync(p,s,64));};
if (process.env.VERCEL && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) throw new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios na Vercel');
let db=fs.existsSync(dataFile)?JSON.parse(fs.readFileSync(dataFile)): {users:[{id:'admin',name:'Eduardo',role:'admin',password:hash(process.env.ADMIN_PASSWORD||'inepad2024')}],partners:[],banks:[],closings:[]};
function save(){fs.writeFileSync(dataFile,JSON.stringify(db,null,2))} save();
const sessions=new Map();
function body(req){return new Promise((res,rej)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{res(b?JSON.parse(b):{})}catch(e){rej(e)}})})}
function send(res,status,obj){res.writeHead(status,{'content-type':'application/json','access-control-allow-origin':'*'});res.end(JSON.stringify(obj))}
function auth(req){const c=req.headers.cookie||'',sid=(c.match(/sid=([^;]+)/)||[])[1];return sessions.get(sid)}
function api(req,res,p){
 if(req.method==='POST'&&p==='/api/login') return body(req).then(x=>{const u=db.users.find(a=>a.id===x.username);if(!u||!verify(x.password,u.password))return send(res,401,{error:'Usuário ou senha inválidos'});const sid=crypto.randomBytes(24).toString('hex');sessions.set(sid,u);res.setHeader('set-cookie',`sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);send(res,200,{user:{id:u.id,name:u.name,role:u.role}})});
 const u=auth(req);if(!u)return send(res,401,{error:'Não autenticado'});
 if(req.method==='GET'&&p==='/api/bootstrap')return send(res,200,{user:{id:u.id,name:u.name,role:u.role},partners:db.partners,banks:db.banks,closings:db.closings,users:db.users.map(x=>({id:x.id,name:x.name,role:x.role}))});
 if(u.role!=='admin')return send(res,403,{error:'Apenas Eduardo pode alterar parâmetros'});
 if(req.method==='POST'&&p==='/api/partners')return body(req).then(x=>{x.id=x.id||crypto.randomUUID();const password=x.password||'inepad123';delete x.password;db.partners.push(x);if(!db.users.some(a=>a.id===x.id))db.users.push({id:x.id,name:x.name,role:'partner',password:hash(password)});save();send(res,200,x)});
 if(req.method==='PUT'&&p.startsWith('/api/partners/'))return body(req).then(x=>{const i=db.partners.findIndex(a=>a.id===p.split('/').pop());if(i<0)return send(res,404,{error:'Sócio não encontrado'});db.partners[i]={...db.partners[i],...x};save();send(res,200,db.partners[i])});
 if(req.method==='POST'&&p==='/api/banks')return body(req).then(x=>{x.id=crypto.randomUUID();db.banks.push(x);save();send(res,200,x)});
 if(req.method==='POST'&&p==='/api/closings')return body(req).then(x=>{x.id=crypto.randomUUID();x.createdAt=new Date().toISOString();db.closings.push(x);save();send(res,200,x)});
 send(res,404,{error:'Rota não encontrada'});
}
const server=http.createServer((req,res)=>{const p=url.parse(req.url).pathname;if(p.startsWith('/api/'))return api(req,res,p);let f=p==='/'?'/public/index.html':p;f=path.join(root,f);if(!f.startsWith(path.join(root,'public')))return send(res,404,{});fs.readFile(f,(e,d)=>{if(e)return send(res,404,{});res.writeHead(200,{'content-type':f.endsWith('.js')?'text/javascript':'text/html'});res.end(d)})});
if (require.main === module) server.listen(process.env.PORT||3000,()=>console.log('INEPAD em http://localhost:'+(process.env.PORT||3000)));
module.exports = server;
