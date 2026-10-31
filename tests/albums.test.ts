import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import AdmZip from 'adm-zip';
import { findAlbums, type ReaderMessage } from '../src/albums.js';
import { renderReaderDay } from '../src/reader-runtime.js';
import { videoPreviews } from '../src/media-previews.js';
import { importBackup, loadGroup } from '../src/importer.js';
import { renderOutput } from '../src/render.js';
import { verifyViews } from '../src/verify-views.js';
import { sha256 } from '../src/storage.js';

const base = Date.parse('2026-10-31T12:00:00Z');
const item = (id: number, seconds = id, extra: Partial<ReaderMessage> = {}): ReaderMessage => ({ id: `post-${id}`, author: 'Alex', date: new Date(base + seconds * 1000), message: '', attachment: `${id}.jpg`, ...extra });

test('three-plus media batches are display-only, preserve order, and stay within a bounded minute', () => {
  const posts = [item(1,0), item(2,30), item(3,60), item(4,90), item(5,120)];
  const before = JSON.stringify(posts), albums = findAlbums(posts, 'Europe/Rome');
  assert.deepEqual(albums, [{ id: 'album-post-1', postIds: ['post-1','post-2','post-3'] }]);
  assert.equal(JSON.stringify(posts), before); assert.deepEqual(findAlbums(posts.slice(0,2), 'Europe/Rome'), []);
});

test('different authors, intervening text, missing media, audio, notices, and day boundaries split albums', () => {
  const textPost = item(2,1); delete textPost.attachment;
  for (const middle of [item(2,1,{author:'Sam'}), textPost, item(2,1,{unresolvedMedia:true}), item(2,1,{attachment:'voice.opus'}), item(2,1,{system:true}), item(2,1,{author:null})]) {
    assert.deepEqual(findAlbums([item(1,0),middle,item(3,2)], 'Europe/Rome'), []);
  }
  const midnight = [item(1,0,{date:'2026-10-31T22:59:59Z'}),item(2,0,{date:'2026-10-31T23:00:00Z'}),item(3,0,{date:'2026-10-31T23:00:01Z'})];
  assert.deepEqual(findAlbums(midnight,'Europe/Rome'),[]);
});

test('mixed albums expose all post IDs, captions and originals, with four previews and a correct overflow count', () => {
  const posts = Array.from({length:17},(_,i)=>item(i,0,{attachment:i%2?`${i}.mp4`:`${i}.jpg`,message:i===5?'<script>alert("caption")</script>':''}));
  const html = renderReaderDay(posts, { timeZone:'Europe/Rome',albums:findAlbums(posts,'Europe/Rome') });
  assert.equal((html.match(/class="album-tile"/g)??[]).length,4); assert.match(html,/>\+13</);
  assert.match(html,/9 photos · 8 videos/); assert.match(html,/View all 17/);
  for (const post of posts) assert.ok(html.includes(`data-post-id="${post.id}"`));
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>alert'));
  assert.match(html,/data-gallery-index="5"/); assert.ok(html.includes('5.mp4'));
  assert.throws(()=>renderReaderDay(posts.slice(1), { albums:[{id:'wrong',postIds:['post-1','post-999','post-2']}] }), /membership/);
});

test('album renderer handles three tiles, lone media and escaped paths without regrouping raw records', () => {
  const posts=[item(1),item(2),item(3)];
  const grouped=renderReaderDay(posts,{albums:findAlbums(posts,'UTC')}); assert.match(grouped,/data-count="3"/);
  assert.match(renderReaderDay([item(1,0,{attachment:'photo #1.jpg'})],{}),/photo%20%231.jpg/);
  const raw=renderReaderDay(posts,{}); assert.ok(!raw.includes('class="message album"')); assert.equal((raw.match(/data-post-id=/g)??[]).length,3);
});

function fixture(t: { after:(f:()=>void)=>void }) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clemcast-albums-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const output=path.join(dir,'output'),archive=path.join(dir,'archive'),zip=new AdmZip();
  zip.addFile('_chat.txt',Buffer.from('[31/10/2026, 12:00:00] Alex: <attached: a.jpg>\n[31/10/2026, 12:00:00] Alex: <attached: b.jpg>\n[31/10/2026, 12:00:00] Alex: <attached: c.jpg>\n[31/10/2026, 12:00:25] Alex: The written update'));
  for(const name of ['a.jpg','b.jpg','c.jpg'])zip.addFile(name,Buffer.from(name));
  const filename=path.join(dir,'WhatsApp Chat - Family.zip');zip.writeZip(filename);importBackup(filename,output,archive,{timeZone:'Europe/Rome',daysFirst:true});
  return {dir,output,archive};
}

test('initial and lazy-loaded HTML share one renderer; chunks and canonical source records retain every post', t => {
  const f=fixture(t),group=path.join(f.output,'family'),before=loadGroup(group);
  renderOutput(f.output); verifyViews(f.output);
  assert.deepEqual(loadGroup(group).messages,before.messages);assert.deepEqual(loadGroup(group).manifest,before.manifest);
  const html=fs.readFileSync(path.join(group,'index.html'),'utf8'); assert.match(html,/data-album-id=/);assert.ok(html.includes('The written update'));
  const assets=JSON.parse(fs.readFileSync(path.join(group,'chunks/manifest.json'),'utf8'));
  assert.equal(assets.totalMessages,4); assert.equal(assets.albums.length,1);
  const posts=loadGroup(group).reconciliation!.posts.filter(post=>post.category==='post');
  const runtime=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]!).find(source=>source.includes('window.__renderReaderDay ='))!;
  const window: Record<string,any>={}; vm.runInNewContext(runtime,{window,document:{addEventListener(){}},Date,Intl});
  assert.equal(window.__renderReaderDay(posts,assets,true),renderReaderDay(posts,assets,true));
  fs.writeFileSync(path.join(group,'index.html'),html.replace('View all 3','View all 2'));
  assert.throws(()=>verifyViews(f.output),/lost an initial post/);
});

test('video posters are cached derivatives, originals stay exact and failed rendering keeps native fallback', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clemcast-posters-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'attachments'));const original=Buffer.from('original video');fs.writeFileSync(path.join(dir,'attachments/a.mp4'),original);
  const hash=sha256(original),manifest={contentHashes:{[hash]:'a.mp4'}},posts=[item(1,0,{attachment:'a.mp4'})] as any;
  let calls=0;const render=()=>{calls++;return Buffer.from([255,216,255,217]);};
  const previews=videoPreviews(dir,posts,manifest,render); assert.equal(calls,1);assert.ok(previews['a.mp4']);
  videoPreviews(dir,posts,manifest,render);assert.equal(calls,1);assert.deepEqual(fs.readFileSync(path.join(dir,'attachments/a.mp4')),original);
  fs.writeFileSync(path.join(dir,previews['a.mp4']!.file),'damaged');videoPreviews(dir,posts,manifest,render);assert.equal(calls,2);
  assert.deepEqual(videoPreviews(dir,posts,manifest,()=>undefined),previews);
  fs.rmSync(path.join(dir,'previews'),{recursive:true}); assert.deepEqual(videoPreviews(dir,posts,manifest,()=>undefined),{});
  assert.match(renderReaderDay(posts,{}),/preload="metadata" muted playsinline/);
});

test('hidden group activity still separates media batches in the actual reading view', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clemcast-album-boundary-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const zip=new AdmZip(), lines=[];
  for(const name of ['a','b','c']) { lines.push(`[31/10/2026, 12:00:00] Alex: <attached: ${name}.jpg>`); zip.addFile(name+'.jpg',Buffer.from(name)); }
  lines.push('[31/10/2026, 12:00:01] Sam added Alex');
  for(const name of ['d','e','f']) { lines.push(`[31/10/2026, 12:00:02] Alex: <attached: ${name}.jpg>`); zip.addFile(name+'.jpg',Buffer.from(name)); }
  zip.addFile('_chat.txt',Buffer.from(lines.join('\n')));const filename=path.join(dir,'WhatsApp Chat - Family.zip');zip.writeZip(filename);
  const output=path.join(dir,'output'),archive=path.join(dir,'archive');importBackup(filename,output,archive,{timeZone:'Europe/Rome',daysFirst:true});renderOutput(output);verifyViews(output);
  const chunks=JSON.parse(fs.readFileSync(path.join(output,'family/chunks/manifest.json'),'utf8'));
  assert.deepEqual(chunks.albums.map((album:{postIds:string[]})=>album.postIds.length),[3,3]);assert.equal(chunks.totalMessages,6);
});
