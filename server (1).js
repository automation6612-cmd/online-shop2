const express=require("express"),fs=require("fs"),path=require("path");
const app=express(),PORT=process.env.PORT||3000,TOKEN=process.env.ADMIN_TOKEN||"change-me";
const products=JSON.parse(fs.readFileSync(path.join(__dirname,"products.json"),"utf8"));
const PAYPAL_ME=/^[A-Za-z0-9._-]+$/.test(process.env.PAYPAL_ME||"")?process.env.PAYPAL_ME:"";
const BANK_INFO=(process.env.BANK_INFO||"").slice(0,400);

// ---- storage: Postgres (Neon) when DATABASE_URL is set, otherwise a local file ----
let store;
if(process.env.DATABASE_URL){
  const pool=new(require("pg").Pool)({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
  pool.query("create table if not exists orders(id text primary key,status text,created_at timestamptz default now(),data jsonb)").catch(e=>console.error("DB init",e.message));
  store={
    all:async()=>(await pool.query("select id,status,created_at,data from orders order by created_at desc limit 500")).rows.map(r=>({...r.data,id:r.id,status:r.status,createdAt:r.created_at})),
    add:async o=>{await pool.query("insert into orders(id,status,data) values($1,$2,$3)",[o.id,o.status,o])},
    set:async(id,s)=>(await pool.query("update orders set status=$2 where id=$1",[id,s])).rowCount
  };
}else{
  const DB=path.join(__dirname,"data","orders.json");fs.mkdirSync(path.dirname(DB),{recursive:true});
  const load=()=>{try{return JSON.parse(fs.readFileSync(DB,"utf8"))}catch{return[]}},save=a=>fs.writeFileSync(DB,JSON.stringify(a,null,2));
  store={all:async()=>load().reverse(),add:async o=>{const a=load();a.push(o);save(a)},
    set:async(id,s)=>{const a=load(),o=a.find(x=>x.id===id);if(!o)return 0;o.status=s;save(a);return 1}};
}

const rate={};
app.set("trust proxy",1);
app.use(express.json({limit:"20kb"}));
app.use((q,r,n)=>{const k=q.ip,t=Date.now();rate[k]=(rate[k]||[]).filter(x=>t-x<6e4);
  if(q.method==="POST"&&rate[k].push(t)>10)return r.status(429).json({error:"Too many requests"});n()});
const wrap=f=>(q,r)=>f(q,r).catch(e=>{console.error(e);r.status(500).json({error:"Server error"})});

app.get("/api/products",(q,r)=>r.json(products));

app.post("/api/orders",wrap(async(q,r)=>{
  const{customer:c={},items=[],pay}=q.body||{};
  const s=v=>String(v||"").trim().slice(0,300);
  if(!s(c.name)||!s(c.phone)||!s(c.address)||!Array.isArray(items)||!items.length||items.length>30)
    return r.status(400).json({error:"Invalid order"});
  let total=0;const lines=[];
  for(const i of items){ // prices always come from the server, never the browser
    const p=products.find(x=>x.id===i.id),v=p&&p.variants.find(x=>x.key===i.variant),qty=Math.floor(i.qty);
    if(!v||!(qty>0&&qty<=20))return r.status(400).json({error:"Invalid item"});
    total+=v.price*qty;lines.push({id:p.id,variant:v.key,name:v.name,price:v.price,qty});
  }
  const method=pay==="bank"?"bank":"paypal";
  const o={id:"MD"+Date.now().toString(36).toUpperCase()+Math.random().toString(36).slice(2,4).toUpperCase(),status:"new",
    createdAt:new Date().toISOString(),pay:method,customer:{name:s(c.name),email:s(c.email),phone:s(c.phone),address:s(c.address)},items:lines,total};
  await store.add(o);
  let payment={text:"We’ll contact you to arrange payment."};
  if(method==="paypal"&&PAYPAL_ME)payment={text:"Please pay $"+total+" with PayPal using the button below and put "+o.id+" in the note.",link:"https://paypal.me/"+PAYPAL_ME+"/"+total+"USD"};
  else if(method==="bank"&&BANK_INFO)payment={text:"Please pay $"+total+" by bank transfer: "+BANK_INFO+" — use "+o.id+" as the payment reference."};
  r.status(201).json({id:o.id,total,payment});
}));

const auth=(q,r,n)=>q.get("x-admin-token")===TOKEN?n():r.status(401).json({error:"Unauthorized"});
app.get("/api/admin/orders",auth,wrap(async(q,r)=>r.json(await store.all())));
app.patch("/api/admin/orders/:id",auth,wrap(async(q,r)=>{
  const st=q.body&&q.body.status;
  if(!["new","paid","confirmed","shipped","delivered","cancelled"].includes(st))return r.status(400).json({error:"Bad status"});
  (await store.set(q.params.id,st))?r.json({ok:true}):r.sendStatus(404);
}));
app.use(express.static(path.join(__dirname,"public")));
app.listen(PORT,()=>console.log("mdar running on :"+PORT));
