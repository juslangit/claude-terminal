import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const OUT='/private/tmp/claude-501/-Users-juslangit/a3a5dd17-4936-4131-8651-36f98583f52a/scratchpad';
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars',
  '--remote-debugging-port=9224','about:blank'],{stdio:'ignore'});
await sleep(2500);
const t=(await (await fetch('http://127.0.0.1:9224/json')).json()).find(x=>x.type==='page');
const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0;const p=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}};
const cmd=(method,params={})=>new Promise(res=>{const i=++id;p.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
const js=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.result.value;
const shot=async(n)=>{const r=await cmd('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(`${OUT}/${n}.png`,Buffer.from(r.result.data,'base64'));};
const results=[];
const check=(n,ok,d='')=>{results.push(ok);console.log(`${ok?'PASS':'FAIL'}  ${n}${d?`  — ${d}`:''}`);};

await cmd('Page.enable'); await cmd('Runtime.enable');
// iPhone 14-ish
await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
await cmd('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
await cmd('Page.navigate',{url:'http://127.0.0.1:4478/'});
await sleep(4500);
await shot('p1-portrait');

check('key bar rendered', await js(`document.querySelectorAll('#keybar button').length`) >= 15,
      `${await js(`document.querySelectorAll('#keybar button').length`)} buttons`);
const dims = await js(`JSON.stringify({c:window.__ct_cols||0,r:window.__ct_rows||0})`);
const termSize = await js(`(()=>{const el=document.querySelector('.xterm-screen');return el?el.offsetWidth+'x'+el.offsetHeight:'none'})()`);
check('terminal sized for the phone', termSize !== 'none', termSize);
check('no horizontal page scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`),
      `scrollWidth ${await js(`document.documentElement.scrollWidth`)} vs ${await js(`window.innerWidth`)}`);

// tap a key-bar button by its real screen position
const tap = async (label) => {
  const box = await js(`(()=>{const b=[...document.querySelectorAll('#keybar button')]
    .find(x=>x.textContent.trim()===${JSON.stringify(label)});
    if(!b)return null;const r=b.getBoundingClientRect();
    b.scrollIntoView({block:'nearest',inline:'center'});
    const r2=b.getBoundingClientRect();
    return JSON.stringify({x:r2.x+r2.width/2,y:r2.y+r2.height/2})})()`);
  if (!box) throw new Error('no button '+label);
  const {x,y} = JSON.parse(box);
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
  await sleep(250);
};

// prove the bar actually drives the shell: ctrl + c interrupts a sleep
await js(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await sleep(200);
for (const ch of 'sleep 30') { await cmd('Input.dispatchKeyEvent',{type:'keyDown',text:ch}); await cmd('Input.dispatchKeyEvent',{type:'keyUp'}); }
await cmd('Input.dispatchKeyEvent',{type:'keyDown',windowsVirtualKeyCode:13,text:'\r'});
await cmd('Input.dispatchKeyEvent',{type:'keyUp',windowsVirtualKeyCode:13});
await sleep(900);

await tap('ctrl');
const armed = await js(`document.querySelector('[data-mod="ctrl"]').classList.contains('armed')`);
check('ctrl arms on tap', armed);
// now type 'c' — should become Ctrl-C
await cmd('Input.dispatchKeyEvent',{type:'keyDown',text:'c'});
await cmd('Input.dispatchKeyEvent',{type:'keyUp'});
await sleep(1000);
const txt = await js(`document.querySelector('#term').innerText`);
check('ctrl + c interrupts via the key bar', txt.includes('^C'), JSON.stringify(txt.slice(-45)));
check('ctrl disarms after one key', !(await js(`document.querySelector('[data-mod="ctrl"]').classList.contains('armed')`)));

// arrows: up recalls the last command
await js(`document.querySelector('#term').__cleared=1`);
await tap('↑');
await sleep(700);
const txt2 = await js(`document.querySelector('#term').innerText`);
check('up arrow works from the key bar', txt2.includes('sleep 30'), JSON.stringify(txt2.slice(-45)));
await tap('esc');
await sleep(300);
await shot('p2-keybar-used');

// rotate to landscape
await cmd('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:3,mobile:true});
await js(`window.dispatchEvent(new Event('orientationchange'))`);
await sleep(1200);
await shot('p3-landscape');
check('no horizontal scroll in landscape', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
const land = await js(`(()=>{const el=document.querySelector('.xterm-screen');return el?el.offsetWidth+'x'+el.offsetHeight:'none'})()`);
check('terminal reflowed on rotation', land !== termSize, `${termSize} → ${land}`);

// manifest + icons reachable
for (const f of ['manifest.json','icon-192.png','icon-512.png']) {
  const ok = await js(`fetch('/${f}').then(r=>r.ok)`);
  check(`serves ${f}`, ok === true);
}
console.log(`\n${results.filter(Boolean).length}/${results.length} phone checks passed`);
chrome.kill(); process.exit(0);
