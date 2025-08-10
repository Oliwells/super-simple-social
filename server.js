// Super Simple GPT-5 Social Poster — Backend (Node/Express + SQLite)
// File: server.js
// What this does now:
// - SQLite persistence (so your drafts survive restarts)
// - Brand CRUD, GPT-5 draft generation, approve/schedule, manual publish (stub)
// - Cron that publishes approved posts when their time arrives (will call LinkedIn later)
//
// Getting started locally:
//   1) npm init -y
//   2) npm i express cors dotenv openai node-cron better-sqlite3
//   3) Create .env with: OPENAI_API_KEY=sk-...  BASE_URL=http://localhost:4000
//   4) node server.js
//
// Deployment (Railway/Render):
//   - Set env vars there (OPENAI_API_KEY, BASE_URL)
//   - Expose port 4000
//   - Add future LinkedIn vars when approved: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_REDIRECT_URI

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

sdb.exec(`
CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  voice TEXT DEFAULT '',
  pillars TEXT DEFAULT '[]', -- JSON array
  cadence_weekdays TEXT DEFAULT '[]', -- JSON array of ints 1..7
  cadence_hour INTEGER DEFAULT 10,
  cadence_minute INTEGER DEFAULT 0,
  platforms TEXT DEFAULT '[]' -- JSON array of strings
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL, -- draft | approved | scheduled | published | failed
  platformTargets TEXT DEFAULT '[]',
  createdAt TEXT,
  scheduledAt TEXT,
  publishedAt TEXT,
  FOREIGN KEY (brand) REFERENCES brands(id)
);
`)

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
  platforms: JSON.parse(r.platforms||'[]')
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

async function generatePostsForBrand(brandId, count=2){
  const br = sdb.prepare('SELECT * FROM brands WHERE id=?').get(brandId)
  if(!br) throw new Error('Brand not found')
  const brand = rowToBrand(br)

  const prompt = `You are a social media copywriter.
Brand: ${brand.name}
Voice: ${brand.voice}
Content pillars: ${brand.pillars.join(', ')}
Platform: LinkedIn (professional, concise, value-forward, light CTA)
Write ${count} concise LinkedIn posts (80–180 words). Vary formats (list, story, tip). Add 2–3 tasteful hashtags. No emojis unless essential. Return as JSON array {"posts":["..."]}.`

  const res = await client.chat.completions.create({
    model: 'gpt-5',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' }
  })

  let texts = []
  try{
    const obj = JSON.parse(res.choices[0].message.content)
    texts = obj.posts || []
  }catch(err){
    texts = [res.choices[0].message.content]
  }

  const times = nextScheduleTimes(brand.cadence, texts.length)
  const insert = sdb.prepare(`INSERT INTO posts (id, brand, text, status, platformTargets, createdAt, scheduledAt) VALUES (?,?,?,?,?,?,?)`)

  const created = texts.map((text, i)=>{
    const p = {
      id: uid(),
      brand: brand.id,
      text,
      status: 'draft',
      platformTargets: JSON.stringify(brand.platforms || ['linkedin']),
      createdAt: iso(),
      scheduledAt: times[i]?.toISOString() || null
    }
    insert.run(p.id, p.brand, p.text, p.status, p.platformTargets, p.createdAt, p.scheduledAt)
    return { ...p, platformTargets: JSON.parse(p.platformTargets) }
  })

  return created
}

async function publishToLinkedIn(post){
  // TODO: Replace stub with real LinkedIn Posts API call once permissions are approved.
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

// Brands
app.get('/brands', (_,res)=>{
  const rows = sdb.prepare('SELECT * FROM brands').all()
  res.json(rows.map(rowToBrand))
})

app.post('/brands', (req,res)=>{
  const { id, name, voice, pillars, cadence, platforms } = req.body
  if(!id || !name) return res.status(400).json({ error:'id and name required' })
  const exists = sdb.prepare('SELECT 1 FROM brands WHERE id=?').get(id)
  if(exists) return res.status(400).json({ error:'brand id exists' })

  const p = Array.isArray(pillars)? pillars : []
  const w = (cadence?.weekdays && Array.isArray(cadence.weekdays))? cadence.weekdays : [2,5]
  const h = Number.isInteger(cadence?.hour)? cadence.hour : 10
  const m = Number.isInteger(cadence?.minute)? cadence.minute : 0
  const pl = Array.isArray(platforms)? platforms : ['linkedin']

  sdb.prepare(`INSERT INTO brands (id,name,voice,pillars,cadence_weekdays,cadence_hour,cadence_minute,platforms)
               VALUES (?,?,?,?,?,?,?,?)`).run(
    id, name, voice||'', JSON.stringify(p), JSON.stringify(w), h, m, JSON.stringify(pl)
  )
  res.json({ ok:true })
})

// Generate drafts
app.post('/brands/:id/generate', async (req,res)=>{
  try{
    const count = Number(req.body.count)||2
    const created = await generatePostsForBrand(req.params.id, count)
    res.json({ ok:true, created })
  }catch(err){
    res.status(500).json({ error: String(err) })
  }
})

// Posts list
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
    scheduledAt:r.scheduledAt, publishedAt:r.publishedAt
  }))
  res.json(mapped)
})

// Update post
app.patch('/posts/:id', (req,res)=>{
  const p = sdb.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id)
  if(!p) return res.status(404).json({ error:'not found' })
  const text = req.body.text ?? p.text
  const status = req.body.status ?? p.status
  const scheduledAt = req.body.scheduledAt ?? p.scheduledAt
  const platformTargets = JSON.stringify(req.body.platformTargets ?? JSON.parse(p.platformTargets||'[]'))
  sdb.prepare('UPDATE posts SET text=?, status=?, scheduledAt=?, platformTargets=? WHERE id=?')
     .run(text, status, scheduledAt, platformTargets, p.id)
  const out = { ...p, text, status, scheduledAt, platformTargets: JSON.parse(platformTargets) }
  res.json(out)
})

// Approve
app.post('/posts/:id/approve', (req,res)=>{
  const p = sdb.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id)
  if(!p) return res.status(404).json({ error:'not found' })
  sdb.prepare('UPDATE posts SET status=? WHERE id=?').run('approved', p.id)
  res.json({ ok:true })
})

// Manual publish (for testing)
app.post('/posts/:id/publish', async (req,res)=>{
  const p = sdb.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id)
  if(!p) return res.status(404).json({ error:'not found' })
  const post = { ...p, platformTargets: JSON.parse(p.platformTargets||'[]') }
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
        const post = { ...p, platformTargets: JSON.parse(p.platformTargets||'[]') }
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
