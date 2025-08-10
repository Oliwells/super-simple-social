// Super Simple GPT-5 Social Poster — Backend (Node/Express + SQLite + Brand Settings)
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cron from 'node-cron'
import OpenAI from 'openai'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

// ====== Config ======
const PORT = process.env.PORT || 4000
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ====== SQLite setup ======
const DATA_DIR = path.join(process.cwd(), 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)
const dbFile = path.join(DATA_DIR, 'app.db')
const sdb = new Database(dbFile)

// Create tables (idempotent)
sdb.exec(`
CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  voice TEXT DEFAULT '',
  pillars TEXT DEFAULT '[]',
  cadence_weekdays TEXT DEFAULT '[]',
  cadence_hour INTEGER DEFAULT 10,
  cadence_minute INTEGER DEFAULT 0,
  platforms TEXT DEFAULT '[]',
  settings TEXT DEFAULT '{}' -- JSON blob for tone/policies/weights
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  platformTargets TEXT DEFAULT '[]',
  createdAt TEXT,
  scheduledAt TEXT,
  publishedAt TEXT,
  postMeta TEXT DEFAULT '{}', -- { pillarKey, pillarLabel, formatKey }
  FOREIGN KEY (brand) REFERENCES brands(id)
);
`)

// ====== Lightweight migrations ======
try { sdb.prepare("SELECT settings FROM brands LIMIT 1").get(); }
catch { sdb.exec("ALTER TABLE brands ADD COLUMN settings TEXT DEFAULT '{}'"); }

try { sdb.prepare("SELECT postMeta FROM posts LIMIT 1").get(); }
catch { sdb.exec("ALTER TABLE posts ADD COLUMN postMeta TEXT DEFAULT '{}'"); }

// ====== Express ======
const app = express()
app.use(cors())
app.use(express.json())

// ====== Helpers ======
const uid = () => Math.random().toString(36).slice(2)
const iso = (d=new Date()) => new Date(d).toISOString()
const rowToBrand = (r)=>({
  id:r.id,
  name:r.name,
  voice:r.voice,
  pillars: JSON.parse(r.pillars||'[]'),
  cadence: { weekdays: JSON.parse(r.cadence_weekdays||'[]'), hour:r.cadence_hour, minute:r.cadence_minute },
  platforms: JSON.parse(r.platforms||'[]'),
  settings: JSON.parse(r.settings||'{}')
})

function nextScheduleTimes(cadence, count=2){
  const times = []
  const now = new Date()
  for(let i=0;i<30 && times.length<count;i++){
    const d = new Date(now)
    d.setDate(now.getDate()+i)
    const weekday = ((d.getDay()+6)%7)+1 // Mon=1..Sun=7
    if((cadence.weekdays||[]).includes(weekday)){
      d.setHours(cadence.hour ?? 10, cadence.minute ?? 0, 0, 0)
      if(d>now) times.push(new Date(d))
    }
  }
  return times
}

function pickWeighted(items){
  const total = items.reduce((a,b)=>a+(b.weight||0),0) || 1
  let n = Math.random()*total
  for(const it of items){ n -= (it.weight||0); if(n<=0) return it }
  return items[0]
}

async function generatePostsForBrand(brandId, count=2){
  const br = sdb.prepare('SELECT * FROM brands WHERE id=?').get(brandId)
  if(!br) throw new Error('Brand not found')
  const brand = rowToBrand(br)

  // Settings with defaults
  const s = brand.settings || {}
  const tone = s.tone || ["thoughtful","bold","non-jargony","practical","values-led"]
  const pov = s.pov || "we"
  const spelling = s.spelling || "UK"
  const emoji = s.emoji || "very_sparing"
  const hashtagPolicy = s.hashtags || { min:0, max:0, house:[] }
  const ctaStyle = s.ctaStyle || { type:"soft", pool:["What’s your take?","How are you approaching this in your organisation?","Contact us if you want to discuss."] }
  const bans = s.bans || ["10x","hustle","game-changing","synergy","paradigm","transformative","cutting-edge"]
  const emdash = s.emdash === false ? "Do not use em dashes (—). Use a simple hyphen (-) only when necessary." : ""

  const pillars = s.pillars || brand.pillars.map((p)=>({ key: p.toLowerCase().replace(/[^a-z0-9]+/g,'_'), label: p, weight: Math.round(100/Math.max(1,brand.pillars.length)) }))
  const formats = s.formats || [
    { key:'thought_insight', label:'Thought-provoking insight', weight:30 },
    { key:'news_linked', label:'News-referenced insight', weight:30 },
    { key:'mini_story', label:'Mini story + lesson', weight:20 },
    { key:'myth_truth', label:'Myth vs truth', weight:5 },
    { key:'opinion', label:'Opinion/stance', weight:5 },
    { key:'question', label:'Question to spark comments', weight:5 },
    { key:'announcement', label:'Announcement', weight:5 }
  ]

  const selections = Array.from({length:count}).map(()=>({
    pillar: pickWeighted(pillars),
    format: pickWeighted(formats)
  }))

  const prompt = `You are a senior LinkedIn copywriter for a UK consultancy.

Brand: ${brand.name}
One-liner: ${(s.tagline||'')}
Point of view: ${pov}
Tone traits: ${tone.join(', ')}
Spelling: ${spelling} English.
Emoji usage: ${emoji}.
${emdash}
Hard avoids: ${bans.join(', ')}.
Hashtags: ${hashtagPolicy.max===0 ? 'Do NOT include any hashtags.' : `Use ${hashtagPolicy.min}-${hashtagPolicy.max} tasteful hashtags from: ${(hashtagPolicy.house||[]).join(' ')}` }
CTA style: ${ctaStyle.type} — choose from: ${(ctaStyle.pool||[]).join(' | ')}
Length: 80–180 words.

Write ${count} LinkedIn posts. Follow the specified pillar & format for each. Output strict JSON: {"posts":[{"text":"...","pillarKey":"...","pillarLabel":"...","formatKey":"..."} ...]}.
Order of pillars/formats: ${selections.map(s=>`[pillar:${s.pillar.label}; format:${s.format.label}]`).join(' | ')}

Guidance:
- Thought-provoking insight: a crisp idea anchored in the pillar with 1–2 concrete examples for UK workplaces.
- News-referenced insight: connect the pillar to a recent UK workplace theme (last month); if uncertain, speak generally without naming outlets.
- Mini story + lesson: 3–5 sentences showing a moment and the takeaway.
- Myth vs truth: one myth, one truth, brief evidence.
- Opinion/stance: clear POV, respectful.
- Question: one specific question leaders can answer.
- Announcement: short, factual, human.

Never overhype. No buzzwords. Avoid platitudes. Keep it people-centred.`

  const res = await client.chat.completions.create({
    model: 'gpt-5',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' }
  })

  let items = []
  try{
    const obj = JSON.parse(res.choices[0].message.content)
    items = obj.posts || []
  }catch(err){
    items = []
  }

  const times = nextScheduleTimes(brand.cadence, Math.max(1, items.length))
  const insert = sdb.prepare(`INSERT INTO posts (id, brand, text, status, platformTargets, createdAt, scheduledAt, postMeta) VALUES (?,?,?,?,?,?,?,?)`)

  const created = items.map((it, i)=>{
    const p = {
      id: uid(),
      brand: brand.id,
      text: (it.text||'').replace(/—/g,'-'),
      status: 'draft',
      platformTargets: JSON.stringify(brand.platforms || ['linkedin']),
      createdAt: iso(),
      scheduledAt: times[i]?.toISOString() || null,
      postMeta: JSON.stringify({ pillarKey: it.pillarKey || selections[i]?.pillar.key, pillarLabel: it.pillarLabel || selections[i]?.pillar.label, formatKey: it.formatKey || selections[i]?.format.key })
    }
    insert.run(p.id, p.brand, p.text, p.status, p.platformTargets, p.createdAt, p.scheduledAt, p.postMeta)
    return { ...p, platformTargets: JSON.parse(p.platformTargets), postMeta: JSON.parse(p.postMeta) }
  })

  return created
}

async function publishToLinkedIn(post){
  console.log('[linkedin] PUBLISH ->', post.text.slice(0,80)+'...')
  return { ok: true, url: 'https://www.linkedin.com/feed/update/mock' }
}

async function publishPost(post){
  const targets = post.platformTargets || []
  const results = []
  for(const platform of targets){
    if(platform==='linkedin') results.push(await publishToLinkedIn(post))
  }
  return results
}

// ====== Routes ======
app.get('/', (_,res)=>res.json({ ok:true, service:'super-simple-social-poster', time: iso() }))

app.get('/brands', (_,res)=>{
  const rows = sdb.prepare('SELECT * FROM brands').all()
  res.json(rows.map(rowToBrand))
})

app.post('/brands', (req,res)=>{
  const { id, name, voice, pillars, cadence, platforms, settings } = req.body
  if(!id || !name) return res.status(400).json({ error:'id and name required' })
  const exists = sdb.prepare('SELECT 1 FROM brands WHERE id=?').get(id)
  if(exists) return res.status(400).json({ error:'brand id exists' })

  const p = Array.isArray(pillars)? pillars : []
  const w = (cadence?.weekdays && Array.isArray(cadence.weekdays))? cadence.weekdays : [2,5]
  const h = Number.isInteger(cadence?.hour)? cadence.hour : 10
  const m = Number.isInteger(cadence?.minute)? cadence.minute : 0
  const pl = Array.isArray(platforms)? platforms : ['linkedin']
  const st = settings && typeof settings==='object' ? settings : {}

  sdb.prepare(`INSERT INTO brands (id,name,voice,pillars,cadence_weekdays,cadence_hour,cadence_minute,platforms,settings)
               VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, name, voice||'', JSON.stringify(p), JSON.stringify(w), h, m, JSON.stringify(pl), JSON.stringify(st)
  )
  res.json({ ok:true })
})

app.patch('/brands/:id', (req,res)=>{
  const b = sdb.prepare('SELECT * FROM brands WHERE id=?').get(req.params.id)
  if(!b) return res.status(404).json({ error:'brand not found' })
  const current = rowToBrand(b)
  const voice = req.body.voice ?? current.voice
  const pillars = JSON.stringify(req.body.pillars ?? current.pillars)
  const c = req.body.cadence ?? current.cadence
  const cadence_weekdays = JSON.stringify(c?.weekdays ?? current.cadence.weekdays)
  const cadence_hour = Number.isInteger(c?.hour) ? c.hour : current.cadence.hour
  const cadence_minute = Number.isInteger(c?.minute) ? c.minute : current.cadence.minute
  const platforms = JSON.stringify(req.body.platforms ?? current.platforms)
  const settings = JSON.stringify(req.body.settings ?? current.settings)

  sdb.prepare(`UPDATE brands SET voice=?, pillars=?, cadence_weekdays=?, cadence_hour=?, cadence_minute=?, platforms=?, settings=? WHERE id=?`)
     .run(voice, pillars, cadence_weekdays, cadence_hour, cadence_minute, platforms, settings, current.id)
  const updated = rowToBrand(sdb.prepare('SELECT * FROM brands WHERE id=?').get(current.id))
  res.json(updated)
})

app.post('/brands/:id/generate', async (req,res)=>{
  try{
    const count = Number(req.body.count)||2
    const created = await generatePostsForBrand(req.params.id, count)
    res.json({ ok:true, created })
  }catch(err){
    res.status(500).json({ error: String(err) })
  }
})

app.get('/posts', (req,res)=>{
  const { brand, status } = req.query
  let sql = 'SELECT * FROM posts'
  const params = []
  const clauses = []
  if(brand){ clauses.push('brand=?'); params.push(brand) }
  if(status){ clauses.push('status=?'); params.push(status) }
  if(clauses.length) sql += ' WHERE ' + clauses.join(' AND ')
  sql += ' ORDER BY createdAt DESC'
  const rows = sdb.prepare(sql).all(...params)
  const mapped = rows.map(r=>({
    id:r.id, brand:r.brand, text:r.text, status:r.status,
    platformTargets: JSON.parse(r.platformTargets||'[]'), createdAt:r.createdAt,
    scheduledAt:r.scheduledAt, publishedAt:r.publishedAt,
    postMeta: JSON.parse(r.postMeta||'{}')
  }))
  res.json(mapped)
})

app.patch('/posts/:id', (req,res)=>{
  const p = sdb.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id)
  if(!p) return res.status(404).json({ error:'not found' })
  const text = (req.body.text ?? p.text).replace(/—/g,'-')
  const status = req.body.status ?? p.status
  const scheduledAt = req.body.scheduledAt ?? p.scheduledAt
  const platformTargets = JSON.stringify(req.body.platformTargets ?? JSON.parse(p.platformTargets||'[]'))
  const postMeta = JSON.stringify(req.body.postMeta ?? JSON.parse(p.postMeta||'{}'))
  sdb.prepare('UPDATE posts SET text=?, status=?, scheduledAt=?, platformTargets=?, postMeta=? WHERE id=?')
     .run(text, status, scheduledAt, platformTargets, postMeta, p.id)
  const out = { ...p, text, status, scheduledAt, platformTargets: JSON.parse(platformTargets), postMeta: JSON.parse(postMeta) }
  res.json(out)
})

app.post('/posts/:id/approve', (req,res)=>{
  const p = sdb.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id)
  if(!p) return res.status(404).json({ error:'not found' })
  sdb.prepare('UPDATE posts SET status=? WHERE id=?').run('approved', p.id)
  res.json({ ok:true })
})

app.post('/posts/:id/publish', async (req,res)=>{
  const p = sdb.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id)
  if(!p) return res.status(404).json({ error:'not found' })
  const post = { ...p, platformTargets: JSON.parse(p.platformTargets||'[]'), postMeta: JSON.parse(p.postMeta||'{}') }
  try{
    const results = await publishPost(post)
    sdb.prepare('UPDATE posts SET status=?, publishedAt=? WHERE id=?').run('published', iso(), p.id)
    res.json({ ok:true, results })
  }catch(err){
    sdb.prepare('UPDATE posts SET status=? WHERE id=?').run('failed', p.id)
    res.status(500).json({ error:String(err) })
  }
})

// ====== Scheduler ======
cron.schedule('* * * * *', async () => {
  const now = new Date()
  const due = sdb.prepare('SELECT * FROM posts WHERE status=? AND scheduledAt IS NOT NULL').all('approved')
  for(const p of due){
    if(new Date(p.scheduledAt) <= now){
      try{
        const post = { ...p, platformTargets: JSON.parse(p.platformTargets||'[]'), postMeta: JSON.parse(p.postMeta||'{}') }
        const results = await publishPost(post)
        sdb.prepare('UPDATE posts SET status=?, publishedAt=? WHERE id=?').run('published', iso(), p.id)
        console.log('Published', p.id, results.map(r=>r.url).join(' | '))
      }catch(err){
        sdb.prepare('UPDATE posts SET status=? WHERE id=?').run('failed', p.id)
        console.error('Publish failed', p.id, err)
      }
    }
  }
})

app.listen(PORT, ()=>{
  console.log(`SSSP backend running at ${BASE_URL}`)
  console.log('SQLite file:', dbFile)
})
