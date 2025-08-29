// api/omada_ext_auth_min.js  — test username/authType schema for extPortal/auth
const OMADA_BASE = (process.env.OMADA_BASE || "https://omada.work2gether.space").replace(/\/+$/, "");
const CTRL = process.env.OMADA_CONTROLLER_ID || "fc2b25d44a950a6357313da0afb4c14a";
const OP_USER = process.env.OMADA_OPERATOR_USER;
const OP_PASS = process.env.OMADA_OPERATOR_PASS;

function send(res, code, obj){res.statusCode=code;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(obj));}
function readBody(req){return new Promise(r=>{let s="";req.on("data",c=>s+=c);req.on("end",()=>{try{r(JSON.parse(s||"{}"))}catch{r({})}})})}

// cookie helpers
function parseSetCookie(h){const out=[];if(!h)return out;const arr=Array.isArray(h)?h:[h];for(const line of arr){const kv=String(line).split(";")[0].trim();if(kv.includes("="))out.push(kv)}return out;}
function mergeCookies(a,b){const m=new Map();for(const c of [...a,...b]){const[n,...r]=c.split("=");m.set(n.trim(),`${n.trim()}=${r.join("=")}`)}return [...m.values()];}
async function fWithCookies(url,opts={},jar=[]){
  const headers=new Headers(opts.headers||{});
  if(jar.length)headers.set("Cookie",jar.join("; "));
  headers.set("User-Agent","w2g-ext-auth-username/2025-08-29");
  headers.set("Accept","application/json,text/html;q=0.9,*/*;q=0.1");
  headers.set("Connection","close");
  headers.set("Pragma","no-cache");
  headers.set("Cache-Control","no-cache");
  headers.set("Accept-Language","en-US,en;q=0.9");
  headers.set("Origin",OMADA_BASE);
  headers.set("Referer",`${OMADA_BASE}/${CTRL}/portal`);
  const resp=await fetch(url,{method:opts.method||"GET",headers,body:opts.body,redirect:"manual"});
  const set=parseSetCookie(resp.headers.get("set-cookie"));
  return {resp,jar:mergeCookies(jar,set)};
}

function macColons(mac){const hex=String(mac).replace(/[^0-9a-f]/gi,"").toUpperCase();if(hex.length!==12)return mac;return hex.match(/.{1,2}/g).join(":");}

async function operatorLogin(jar=[]){
  const url=`${OMADA_BASE}/${CTRL}/api/v2/hotspot/login?_=${Date.now()}`;
  const headers={"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"};
  const body=JSON.stringify({name:OP_USER,password:OP_PASS});
  const {resp,jar:j2}=await fWithCookies(url,{method:"POST",headers,body},jar);
  const text=await resp.text().catch(()=> "");
  let token=null;try{const j=JSON.parse(text);token=j?.result?.token||j?.token||null;}catch{}
  const hdr=resp.headers.get("csrf-token")||resp.headers.get("x-csrf-token")||null;
  return {status:resp.status,token:token||hdr||null,raw:text,jar:j2};
}

module.exports=async (req,res)=>{
  if(req.method!=="POST")return send(res,405,{ok:false,error:"Use POST."});
  if(!OP_USER||!OP_PASS)return send(res,500,{ok:false,error:"Missing OMADA_OPERATOR_USER/PASS"});

  const b=await readBody(req);
  const site=b.site||"688c13adee75005c5bb411bd";
  const mac=macColons(b.clientMac||"C8-5E-A9-EE-D9-46");

  try{
    // warm
    let jar=[];
    const warm=await fWithCookies(`${OMADA_BASE}/${CTRL}/hotspot/login?_=${Date.now()}`,{method:"GET"},jar);
    jar=warm.jar;await warm.resp.text().catch(()=>{});

    // operator login
    const op=await operatorLogin(jar); jar=op.jar; const token=op.token||null;

    // extPortal/auth with username/authType
    const authUrl=`${OMADA_BASE}/${CTRL}/api/v2/hotspot/extPortal/auth?_=${Date.now()}`;
    const headers={
      "Content-Type":"application/json",
      "X-Requested-With":"XMLHttpRequest",
      ...(token?{"Csrf-Token":token}:{ }),
      Referer:`${OMADA_BASE}/${CTRL}/hotspot/login`,
    };
    const posted={ site, username: mac, authType: 4 };
    const r=await fWithCookies(authUrl,{method:"POST",headers,body:JSON.stringify(posted)},jar);
    const text=await r.resp.text().catch(()=> "");
    let data; try{data=JSON.parse(text);}catch{data={errorCode:-1,msg:"Non-JSON",raw:text};}

    return send(res,200,{
      ok:data?.errorCode===0,
      input:{site,username:mac,authType:4},
      operatorLogin:{status:op.status,token:!!token},
      auth:{http:r.resp.status,data,posted}
    });
  }catch(e){
    return send(res,200,{ok:false,error:e?.message||String(e)});
  }
};
