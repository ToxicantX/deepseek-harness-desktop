import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MAX_BYTES = 12 * 1024 * 1024
const MAX_TEXT = 12_000
const TIMEOUT_MS = 12_000

export async function recognizeImage(buffer: Uint8Array): Promise<string> {
  if (buffer.byteLength > MAX_BYTES) throw new Error('图片超过 12 MB OCR 限制')
  const path = join(tmpdir(), 'dsh-ocr-' + process.pid + '-' + randomUUID() + '.image')
  await writeFile(path, buffer)
  try {
    const command = await findTesseract()
    if (command === undefined) throw new Error('未找到 Tesseract OCR，请安装后重试')
    return (await run(command, path, 'eng+chi_sim')) ?? (await run(command, path, 'eng')) ?? ''
  } finally { await unlink(path).catch(() => {}) }
}

async function findTesseract(): Promise<string | undefined> {
  const candidates = process.platform === 'win32' ? ['C:\\\\Program Files\\\\Tesseract-OCR\\\\tesseract.exe', 'C:\\\\Program Files (x86)\\\\Tesseract-OCR\\\\tesseract.exe', 'tesseract'] : ['tesseract']
  for (const candidate of candidates) { if (candidate === 'tesseract') return candidate; try { await access(candidate); return candidate } catch { /* next */ } }
  return undefined
}

function run(command: string, image: string, language: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(command, [image, 'stdout', '-l', language], { stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''; const timer = setTimeout(() => { child.kill(); resolve(null) }, TIMEOUT_MS)
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > MAX_TEXT) child.kill() })
    child.once('error', () => { clearTimeout(timer); resolve(null) })
    child.once('close', code => { clearTimeout(timer); resolve(code === 0 || output.length > 0 ? output.slice(0, MAX_TEXT).trim() : null) })
  })
}

export function createOcrInjectorScript(): string {
  return String.raw`(() => {
  'use strict';
  const key='__dshDesktopOcr'; const old=window[key]; if(old && old.dispose) old.dispose();
  const api=window.dshDesktopOcr; const disposers=[]; let input,status,clear,selected;
  const editor=()=>[...document.querySelectorAll('textarea,[contenteditable="true"]')].find(n=>n instanceof HTMLElement && n.getBoundingClientRect().width>0 && n.getBoundingClientRect().height>0);
  const val=n=>n instanceof HTMLTextAreaElement||n instanceof HTMLInputElement?n.value:n.innerText;
  const setVal=(n,v)=>{if(n instanceof HTMLTextAreaElement||n instanceof HTMLInputElement){const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(n),'value');if(d&&d.set)d.set.call(n,v);else n.value=v}else n.innerText=v;n.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}))};
  const inject=()=>{const e=editor();if(!e||!selected)return;const marker='--- 图片 OCR 识别结果：'+selected.name+' ---';if(val(e).includes(marker))return;setVal(e,val(e)+'\\n\\n'+marker+'\\n'+selected.text+'\\n--- 图片 OCR 结束 ---')};
  const send=e=>{if(e.type==='keydown'&&(e.key!=='Enter'||e.shiftKey||e.isComposing))return;if(e.target&&e.target.closest&&e.target.closest('[data-dsh-ocr-control]'))return;if(selected)inject()};
  const choose=async()=>{const f=input.files&&input.files[0];if(!f)return;try{if(!api||!api.recognize)throw new Error('OCR 接口不可用');status.textContent='正在识别 '+f.name+' …';const text=await api.recognize(await f.arrayBuffer());selected={name:f.name,text:text||'（未识别到文字）'};clear.hidden=false;status.textContent='已识别，发送时自动注入'}catch(e){selected=undefined;clear.hidden=true;status.textContent=e instanceof Error?e.message:String(e)}finally{input.value=''}};
  const root=document.createElement('div');root.dataset.dshOcrRoot='true';Object.assign(root.style,{position:'fixed',left:'16px',bottom:'52px',zIndex:'2147483000',display:'flex',gap:'6px',alignItems:'center',padding:'6px 8px',border:'1px solid rgba(127,127,127,.4)',borderRadius:'8px',background:'Canvas',color:'CanvasText',font:'12px system-ui',boxShadow:'0 4px 18px rgba(0,0,0,.2)'});
  const button=document.createElement('button');button.type='button';button.textContent='图片 OCR';button.dataset.dshOcrControl='true';input=document.createElement('input');input.type='file';input.accept='image/*';input.hidden=true;clear=document.createElement('button');clear.type='button';clear.textContent='清除 OCR';clear.dataset.dshOcrControl='true';clear.hidden=true;status=document.createElement('span');status.textContent='未选择图片';button.onclick=()=>input.click();clear.onclick=()=>{selected=undefined;clear.hidden=true;status.textContent='未选择图片'};input.onchange=()=>void choose();root.append(button,clear,input,status);document.body.append(root);document.addEventListener('keydown',send,true);document.addEventListener('click',send,true);disposers.push(()=>root.remove(),()=>document.removeEventListener('keydown',send,true),()=>document.removeEventListener('click',send,true));window[key]={dispose(){for(const d of disposers.splice(0))d();delete window[key]}};return {ok:true};
})()`
}
