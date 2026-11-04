// Executable acceptance spec, provider level. Synthetic data shaped from E1 anonymized structure. No network.
// usage: node quote-acceptance.mjs <lark-interactions.js> ; every case runs independently (no first-failure masking).
import { pathToFileURL, fileURLToPath } from 'node:url'
const { createLarkInteractions } = await import(pathToFileURL(process.argv[2] || fileURLToPath(new URL('../lib/lark-interactions.js', import.meta.url))))
const N='请升级至最新版本客户端，以查看内容', QUERY='/im/v1/messages/m?card_msg_content_type=user_card_content'
const BODY='FINAL_MARKER '+'答'.repeat(3161-13)
const e1card=(content=BODY,mode=false)=>({body:{elements:[{content,element_id:'dsh_streaming_x_18',tag:'markdown'}]},config:{streaming_config:{print_frequency_ms:{default:70},print_step:{default:1},print_strategy:'fast'},streaming_mode:mode,summary:{content:'SUMMARY_MARKER'}},schema:'2.0'})
const skeleton=(title=null,pieces=[N,''])=>({title,elements:[[{tag:'img',image_key:'IMGKEY_MARKER'},...pieces.map(text=>({tag:'text',text}))]]})
const item=(content,x={})=>({ok:true,status:200,json:{code:0,data:{items:[{message_id:'m',chat_id:'c',msg_type:'interactive',updated:true,deleted:false,body:{content:JSON.stringify(content)},...x}]}}})
const q=async raw=>{const urls=[];const p=createLarkInteractions({request:async(_b,m,u)=>{urls.push(m+' '+u);return raw}});const r=await p.quote({chatId:'c'},{messageId:'m'},{check(){},onDispatch(){}});return{r,urls}}
const shut=r=>r.ok===false
const cases=[
 ['R0','E1 real streaming-closed shape readable, whole text, one GET',item(e1card()),({r,urls})=>r.ok&&r.text===BODY&&!r.truncated&&urls.length===1&&urls[0]==='GET '+QUERY],
 ['R0','E1 shape never leaks element_id/summary/config',item(e1card()),({r})=>r.ok&&!/dsh_streaming|SUMMARY_MARKER|print_/.test(r.text)],
 ['R1','real default skeleton [img,notice,""] title null closed',item(skeleton()),({r})=>shut(r)],
 ['R1','single-piece notice+NL closed',item(skeleton(null,[N+'\n'])),({r})=>shut(r)],
 ['R1','notice + whitespace piece closed',item(skeleton(null,[N,' \n\t'])),({r})=>shut(r)],
 ['R1','notice + ideographic/nbsp whitespace closed',item(skeleton(null,[N,'　 '])),({r})=>shut(r)],
 ['R1','only blank pieces closed',item(skeleton(null,['',' '])),({r})=>shut(r)],
 ['R1','title + real skeleton closed (title-only is unreadable)',item(skeleton('TITLE')),({r})=>shut(r)],
 ['R1','header title + blank markdown closed',item({schema:'2.0',header:{title:{content:'TITLE'}},body:{elements:[{tag:'markdown',content:'  '}]}}),({r})=>shut(r)],
 ['R1','notice as title not emitted beside real body',item({title:N,elements:[[{tag:'text',text:'REAL'}]]}),({r})=>r.ok&&r.text.includes('REAL')&&!r.text.includes('请升级')],
 ['R1','real title + real body keep both',item({schema:'2.0',header:{title:{content:'TITLE'}},body:{elements:[{tag:'markdown',content:'REAL'}]}}),({r})=>r.ok&&r.text==='TITLE\nREAL'],
 ['R1','notice removed beside real piece, blank dropped',item(skeleton(null,[N,'','REAL'])),({r})=>r.ok&&r.text==='REAL'],
 ['R2','streaming_mode true with real text closed',item(e1card('SEED_MARKER',true)),({r})=>shut(r)&&!JSON.stringify(r).includes('SEED_MARKER')],
 ['R2','streaming_mode true with ellipsis closed',item(e1card('…',true)),({r})=>shut(r)],
 ['R2','closed card with ellipsis-only body closed',item(e1card('…',false)),({r})=>shut(r)],
 ['R2','ellipsis + whitespace closed',item(e1card(' …\n',false)),({r})=>shut(r)],
 ['R2','ellipsis inside real text retained',item(e1card('等一下…然后继续',false)),({r})=>r.ok&&r.text==='等一下…然后继续'],
 ['R2','ellipsis piece beside real piece keeps real',item({schema:'2.0',config:{streaming_mode:false},body:{elements:[{tag:'markdown',content:'…'},{tag:'markdown',content:'REAL'}]}}),({r})=>r.ok&&r.text.includes('REAL')],
 ['R7','wrong message_id closed without body',item(e1card('LEAK_MARKER'),{message_id:'other'}),({r})=>r.code==='target_unverified'&&!JSON.stringify(r).includes('LEAK_MARKER')],
 ['R7','missing message_id closed',item(e1card('LEAK_MARKER'),{message_id:undefined}),({r})=>r.code==='target_unverified'],
 ['R7','wrong chat closed without body',item(e1card('LEAK_MARKER'),{chat_id:'other'}),({r})=>r.code==='target_unverified'&&!JSON.stringify(r).includes('LEAK_MARKER')],
 ['R7','deleted closed',item(e1card('LEAK_MARKER'),{deleted:true}),({r})=>r.code==='not_found_or_recalled'],
 ['R7','no false positive: sentence containing notice',item(e1card(`用户截图显示“${N}”，下一步是升级`)),({r})=>r.ok&&r.text.includes('下一步')],
 ['R7','no false positive: other 请升级 sentence',item(e1card('请升级系统后重启')),({r})=>r.ok&&r.text==='请升级系统后重启'],
 ['R7','no false positive: text message equal to notice',item({text:N},{msg_type:'text'}),({r})=>r.ok&&r.text===N],
 ['R7','no false positive: post message equal to notice',item({zh_cn:{title:'',content:[[{tag:'text',text:N}]]}},{msg_type:'post'}),({r})=>r.ok&&r.text.includes(N)],
 ['R7','opaque card reference closed, no id',item({type:'card',data:{card_id:'CARD_MARKER'}}),({r})=>shut(r)&&!JSON.stringify(r).includes('CARD_MARKER')],
 ['R7','action url/value never extracted',item({schema:'2.0',body:{elements:[{tag:'markdown',content:'REAL'},{tag:'button',text:{tag:'plain_text',content:'BTN'},url:'https://URL_MARKER',value:{k:'VALUE_MARKER'}}]}}),({r})=>r.ok&&!/URL_MARKER|VALUE_MARKER/.test(r.text)],
 ['R5','node-budget overflow must say truncated',item({schema:'2.0',body:{elements:Array.from({length:1000},(_,i)=>({tag:'markdown',content:'P'+i}))}}),({r})=>r.ok&&!r.text.includes('P999')&&r.truncated===true],
 // Added regressions; the 29 Opus cases above remain unchanged.
 ['R5','depth-budget loss must say truncated',item({body:{elements:[{tag:'markdown',content:'REAL'},Array.from({length:20}).reduce(x=>[x],{tag:'markdown',content:'DEPTH_TAIL'})]}}),({r})=>r.ok&&r.text==='REAL'&&r.truncated===true],
 ['R2','ellipsis piece beside real piece is retained verbatim',item({body:{elements:[{tag:'markdown',content:'…'},{tag:'markdown',content:'REAL'}]}}),({r})=>r.ok&&r.text==='…\nREAL'],
 ['R8','inline Markdown URLs mentions and image keys remain data',item(e1card('[link](https://synthetic.invalid) <at id=synthetic>name</at> img_v3_synthetic')),({r})=>r.ok&&r.text==='[link](https://synthetic.invalid) <at id=synthetic>name</at> img_v3_synthetic'],

]
const fails=[];for(const[g,n,raw,ok]of cases){let pass=false;try{pass=!!ok(await q(raw))}catch(e){}console.log((pass?'PASS':'FAIL')+' '+g+' '+n);if(!pass)fails.push(g+' '+n)}
console.log('SUMMARY total='+cases.length+' fail='+fails.length);process.exitCode=fails.length?1:0
