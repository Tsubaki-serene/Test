(()=>{
'use strict';
function createBinaryEngine() {
  'use strict';
  const LIMIT = 64 * 1024 * 1024;
  const utf8 = new TextDecoder(), utf16 = new TextDecoder('utf-16le');
  const enc = new TextEncoder();
  const ensure = (yes, message) => { if (!yes) throw new Error(message); };
  const eq = (a,b) => a.length === b.length && a.every((v,i) => v === b[i]);
  const align = (v,n) => Math.ceil(v / n) * n;
  const hex = a => Array.from(a, v => v.toString(16).padStart(2,'0')).join('');
  const hash = async a => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', a)));
  const view = a => new DataView(a.buffer, a.byteOffset, a.byteLength);
  function slice(a,p,n) { ensure(Number.isSafeInteger(p) && Number.isSafeInteger(n) && p>=0 && n>=0 && p+n<=a.length, '二进制范围异常'); return a.subarray(p,p+n); }
  function find(a,needle,start=0) {
    outer: for(let i=start;i<=a.length-needle.length;i++) { for(let k=0;k<needle.length;k++) if(a[i+k]!==needle[k]) continue outer; return i; }
    return -1;
  }
  function reader(a,p=0,le=false) {
    const d=view(a);
    return { get p(){return p;}, set p(v){slice(a,v,0);p=v;},
      u8(){slice(a,p,1);return a[p++];},
      u16(){slice(a,p,2);const v=d.getUint16(p,le);p+=2;return v;},
      u32(){slice(a,p,4);const v=d.getUint32(p,le);p+=4;return v;},
      u64(){slice(a,p,8);const v=Number(d.getBigUint64(p,le));p+=8;ensure(Number.isSafeInteger(v),'64 位数值越界');return v;},
      bytes(n){const b=slice(a,p,n);p+=n;return b;},
      str(max=4096){const start=p;while(p<a.length&&a[p]&&p-start<max)p++;ensure(p<a.length&&a[p]===0,'字符串越界');const s=utf8.decode(a.subarray(start,p));p++;return s;}
    };
  }
  function lz4(input,size) {
    ensure(size>=0 && size<=LIMIT,'解压长度越界');const output=new Uint8Array(size);let i=0,j=0;
    const next=()=>{ensure(i<input.length,'LZ4 数据截断');return input[i++];};
    while(i<input.length) {
      const token=next();let length=token>>>4;
      if(length===15){let v;do{v=next();length+=v;}while(v===255);}
      ensure(i+length<=input.length&&j+length<=size,'LZ4 字面量越界');output.set(input.subarray(i,i+length),j);i+=length;j+=length;
      if(i===input.length)break;
      const distance=next() | next()<<8;ensure(distance>0&&distance<=j,'LZ4 引用越界');length=(token&15)+4;
      if(length===19){let v;do{v=next();length+=v;}while(v===255);}
      ensure(j+length<=size,'LZ4 匹配长度越界');while(length--){output[j]=output[j-distance];j++;}
    }
    ensure(j===size,'LZ4 输出长度不一致');return output;
  }
  function expand(raw,size,flags) {
    const mode=flags&63;
    ensure(mode===0||mode===2||mode===3,'不支持此压缩方式');
    if(mode===0){ensure(raw.length===size,'未压缩块长度不一致');return raw;}
    return lz4(raw,size);
  }
  function unpack(bytes) {
    ensure(bytes.length<=LIMIT,'资源过大');const base=find(bytes,enc.encode('UnityFS\0'));
    ensure(base>=0&&base<=128&&bytes.subarray(0,base).every(x=>x===0),'不支持的资源封装');
    const r=reader(bytes,base+8),version=r.u32();ensure(version===7||version===8,'不支持此 UnityFS 版本');
    const unity=r.str(),revision=r.str(),sizeAt=r.p,size=r.u64(),infoSize=r.u32(),infoUnpacked=r.u32(),flags=r.u32(),headerEnd=r.p;
    ensure(base+size===bytes.length,'资源长度不一致');ensure((flags&~0x3ff)===0&&(flags&64),'不支持此 UnityFS 标志');
    ensure(infoUnpacked>=20&&infoUnpacked<1024*1024,'块表长度异常');
    const headerAligned=base+align(headerEnd-base,16),infoAt=flags&128?bytes.length-infoSize:headerAligned;
    const info=expand(slice(bytes,infoAt,infoSize),infoUnpacked,flags),ir=reader(info,16);
    const n=ir.u32();ensure(n>0&&n<=4096,'压缩块数量异常');const blocks=[];let total=0;
    let dataAt=flags&128?headerAligned:infoAt+infoSize;if(flags&512)dataAt=base+align(dataAt-base,16);
    for(let i=0;i<n;i++) {
      const infoPos=ir.p,us=ir.u32(),cs=ir.u32(),bf=ir.u16();ensure(us>0&&total+us<=LIMIT,'解压总长度异常');
      const raw=slice(bytes,dataAt,cs);blocks.push({us,cs,flags:bf,infoPos,at:dataAt,offset:total,raw});dataAt+=cs;total+=us;
    }
    ensure(dataAt<=(flags&128?infoAt:bytes.length),'压缩数据和块表重叠');
    ensure(bytes.subarray(dataAt,flags&128?infoAt:bytes.length).every(x=>x===0),'未知尾部数据');
    const nc=ir.u32();ensure(nc>0&&nc<=1024,'目录项数量异常');const nodes=[];
    for(let i=0;i<nc;i++){const offset=ir.u64(),size=ir.u64(),nf=ir.u32(),name=ir.str();ensure(offset+size<=total,'目录项越界');nodes.push({offset,size,flags:nf,name});}
    ensure(ir.p===info.length,'块表尾部未知数据');const data=new Uint8Array(total);
    for(const b of blocks)data.set(expand(b.raw,b.us,b.flags),b.offset);
    return {bytes,base,version,unity,revision,sizeAt,headerEnd,flags,info,blocks,nodes,data};
  }
  function repack(bundle,data) {
    if(bundle.resized)return repackResized(bundle,data);
    ensure(data.length===bundle.data.length,'禁止变更资产总长度');const info=bundle.info.slice(),iv=view(info);
    info.fill(0,0,16);const raws=[];
    for(const block of bundle.blocks) {
      const changed=!eq(data.subarray(block.offset,block.offset+block.us),bundle.data.subarray(block.offset,block.offset+block.us));
      const raw=changed?data.subarray(block.offset,block.offset+block.us):block.raw;
      raws.push(raw);iv.setUint32(block.infoPos+4,raw.length,false);iv.setUint16(block.infoPos+8,changed?(block.flags&~63):block.flags,false);
    }
    const flags=bundle.flags&~63;
    const h=bundle.base+align(bundle.headerEnd-bundle.base,16);
    let dataAt=flags&128?h:h+info.length;if(flags&512)dataAt=bundle.base+align(dataAt-bundle.base,16);
    const dataSize=raws.reduce((s,x)=>s+x.length,0),infoAt=flags&128?dataAt+dataSize:h;
    const out=new Uint8Array(flags&128?infoAt+info.length:dataAt+dataSize);
    out.set(bundle.bytes.subarray(0,bundle.headerEnd));const d=view(out);
    d.setBigUint64(bundle.sizeAt,BigInt(out.length-bundle.base),false);
    d.setUint32(bundle.sizeAt+8,info.length,false);d.setUint32(bundle.sizeAt+12,info.length,false);d.setUint32(bundle.sizeAt+16,flags,false);
    out.set(info,infoAt);for(const raw of raws){out.set(raw,dataAt);dataAt+=raw.length;}
    return out;
  }
  function compressed(r) {
    const a=r.u8();if(a<128)return a;if(a<192)return (a&63)*256+r.u8();
    ensure(a<224,'CLI 压缩整数异常');return (a&31)*16777216+r.u8()*65536+r.u8()*256+r.u8();
  }
  function parsePE(bytes) {
    const layout=peLayout(bytes),d=view(bytes),u32=p=>d.getUint32(p,true);
    const {opt,magic,offset}=layout;
    ensure(layout.directories.length>14,'CLI 数据目录缺失');
    const cli=offset(u32(opt+(magic===0x10b?96:112)+14*8),72),md=offset(u32(cli+8),u32(cli+12));
    ensure(u32(md)===0x424a5342,'CLI 元数据异常');
    const mr=reader(bytes,align(md+16+u32(md+12),4),true);mr.u16();const sn=mr.u16(),streams={};ensure(sn<32,'元数据流过多');
    for(let i=0;i<sn;i++){const at=md+mr.u32(),size=mr.u32(),name=mr.str(32);mr.p=align(mr.p,4);streams[name]={at,size,data:slice(bytes,at,size)};}
    ensure(streams['#Strings']&&streams['#Blob']&&(streams['#~']||streams['#-']),'元数据流缺失');
    const tr=reader((streams['#~']||streams['#-']).data,0,true);tr.u32();tr.u8();tr.u8();const heaps=tr.u8();tr.u8();
    const validLow=tr.u32(),validHigh=tr.u32();tr.u32();tr.u32();const rows=Array(64).fill(0);
    for(let i=0;i<64;i++)if((i<32?validLow>>>i:validHigh>>>(i-32))&1){rows[i]=tr.u32();ensure(rows[i]<2000000,'表行数异常');}
    ensure(rows.slice(45).every(x=>x===0),'不支持的 CLI 元数据表');
    ensure(rows[3]===0&&rows[5]===0,'不支持间接字段或方法表');
    const idx=t=>rows[t]<65536?2:4,ci=(bits,t)=>Math.max(...t.map(i=>rows[i]))<2**(16-bits)?2:4;
    const ss=heaps&1?4:2,gs=heaps&2?4:2,bs=heaps&4?4:2,tdr=ci(2,[2,1,27]),mdr=ci(1,[6,10]);
    const sizes=[2+ss+3*gs,ci(2,[0,26,35,1])+2*ss,4+2*ss+tdr+idx(4)+idx(6),idx(4),2+ss+bs,idx(6),8+ss+bs+idx(8),idx(8),4+ss,idx(2)+tdr,ci(3,[2,1,26,6,27])+ss+bs,
      2+ci(2,[4,8,23])+bs,ci(5,[6,4,1,2,8,9,10,0,14,23,20,17,26,27,32,35,38,39,40,42,44,43])+ci(3,[6,10])+bs,ci(1,[4,8])+bs,2+ci(2,[2,6,32])+bs,6+idx(2),4+idx(4),bs,idx(2)+idx(20),idx(20),2+ss+tdr,idx(2)+idx(23),idx(23),2+ss+bs,2+idx(6)+ci(1,[20,23]),idx(2)+2*mdr,ss,bs,2+ci(1,[4,6])+ss+idx(26),4+idx(4),8,4,16+bs+2*ss,4,12,12+2*bs+2*ss,4+idx(35),12+idx(35),4+ss+bs,8+2*ss+ci(2,[38,35,39]),8+ss+ci(2,[38,35,39]),2*idx(2),4+ci(1,[2,6])+ss,mdr+bs,idx(42)+tdr];
    const starts=[];for(let i=0;i<sizes.length;i++){starts[i]=tr.p;tr.bytes(sizes[i]*rows[i]);}
    const table=(t,row)=>{ensure(row>0&&row<=rows[t],'元数据引用越界');return reader((streams['#~']||streams['#-']).data,starts[t]+sizes[t]*(row-1),true);};
    const readIdx=(r,size)=>size===2?r.u16():r.u32();
    const str=i=>reader(streams['#Strings'].data,i).str(100000);
    const blob=i=>{const r=reader(streams['#Blob'].data,i);return r.bytes(compressed(r));};
    const typeDefs=[];for(let i=1;i<=rows[2];i++){const r=table(2,i),flags=r.u32(),name=str(readIdx(r,ss)),ns=str(readIdx(r,ss)),extendsType=readIdx(r,tdr);typeDefs.push({row:i,flags,name:(ns?ns+'.':'')+name,extendsType,field:readIdx(r,idx(4)),method:readIdx(r,idx(6))});}
    const nested=new Map();for(let i=1;i<=rows[41];i++){const r=table(41,i);nested.set(readIdx(r,idx(2)),readIdx(r,idx(2)));}
    const methods=[],fields=[];
    for(let i=1;i<=rows[6];i++){const r=table(6,i);methods.push({row:i,rva:r.u32(),impl:r.u16(),flags:r.u16(),name:str(readIdx(r,ss)),sig:readIdx(r,bs)});}
    for(let i=1;i<=rows[4];i++){const r=table(4,i);fields.push({row:i,flags:r.u16(),name:str(readIdx(r,ss)),sig:readIdx(r,bs)});}
    const owner=(row,key)=>{for(let i=typeDefs.length-1;i>=0;i--)if(typeDefs[i][key]<=row)return typeDefs[i].row;throw new Error('成员没有所属类型');};
    const caches=new Map();
    function type(r,depth) {
      ensure(depth<40,'类型签名递归过深');const t=r.u8();
      if([1,2,3,4,5,6,7,8,9,10,11,12,13,14,22,24,25,28].includes(t))return 'p'+t;
      if([15,16,29,69].includes(t))return t+'('+type(r,depth+1)+')';
      if(t===17||t===18)return t+':'+codedType(compressed(r),depth+1);
      if(t===19||t===30)return t+':'+compressed(r);
      if(t===31||t===32)return t+':'+codedType(compressed(r),depth+1)+'('+type(r,depth+1)+')';
      if(t===21){const kind=r.u8();ensure(kind===17||kind===18,'泛型类型异常');const base=codedType(compressed(r),depth+1),n=compressed(r);ensure(n<=64,'泛型参数过多');return kind+':'+base+'<'+Array.from({length:n},()=>type(r,depth+1)).join(',')+'>';}
      if(t===20){const element=type(r,depth+1),rank=compressed(r),n=compressed(r);ensure(rank<64&&n<64,'数组签名异常');const sizes=Array.from({length:n},()=>compressed(r)),l=compressed(r);ensure(l<64,'数组下界异常');return 'array('+element+','+rank+','+sizes+','+Array.from({length:l},()=>compressed(r))+')';}
      if(t===27)return 'fn('+signatureReader(r,depth+1)+')';
      throw new Error('不支持的类型签名 '+t);
    }
    function signatureReader(r,depth=0) {
      ensure(depth<40,'方法签名递归过深');const flags=r.u8();
      if(flags===6)return 'field:'+type(r,depth+1);
      if(flags===7||flags===10){const n=compressed(r);ensure(n<1024,'签名参数过多');return flags+':'+Array.from({length:n},()=>type(r,depth+1)).join(',');}
      const generic=flags&16?compressed(r):0,n=compressed(r);ensure(n<1024,'方法参数过多');const ret=type(r,depth+1),args=[];
      for(let i=0;i<n;i++)args.push(type(r,depth+1));
      return flags+':'+generic+':'+ret+'('+args.join(',')+')';
    }
    function signature(index,depth=0,onlyType=false){const b=blob(index),r=reader(b);const s=onlyType?type(r,depth+1):signatureReader(r,depth+1);ensure(r.p===b.length,'签名未完整解析');return s;}
    function codedType(c,depth){const kinds=[2,1,27];ensure((c&3)<3,'类型引用标签异常');return resolve(kinds[c&3]*16777216+(c>>>2),depth+1);}
    function resolve(token,depth=0) {
      ensure(depth<40,'元数据递归过深');if(caches.has(token))return caches.get(token);const t=token>>>24,row=token&0xffffff;let value;
      if(t===2){const item=typeDefs[row-1];ensure(item,'类型不存在');value=(nested.has(row)?resolve(0x02000000+nested.get(row),depth+1)+'+':'')+item.name;}
      else if(t===1){const r=table(1,row),scope=readIdx(r,ci(2,[0,26,35,1])),name=str(readIdx(r,ss)),ns=str(readIdx(r,ss));value='ref('+resolve([0,26,35,1][scope&3]*16777216+(scope>>>2),depth+1)+'):'+(ns?ns+'.':'')+name;}
      else if(t===0){value='module';}
      else if(t===26){value='module:'+str(readIdx(table(t,row),ss));}
      else if(t===35){const r=table(t,row);r.bytes(12);readIdx(r,bs);value='assembly:'+str(readIdx(r,ss));}
      else if(t===4){const f=fields[row-1];ensure(f,'字段不存在');value=resolve(0x02000000+owner(row,'field'),depth+1)+'::'+f.name+':'+f.flags+':'+signature(f.sig,depth+1);}
      else if(t===6){const m=methods[row-1];ensure(m,'方法不存在');value=resolve(0x02000000+owner(row,'method'),depth+1)+'::'+m.name+':'+m.flags+':'+signature(m.sig,depth+1);}
      else if(t===10){const r=table(t,row),parent=readIdx(r,ci(3,[2,1,26,6,27])),tag=parent&7;ensure(tag<5,'成员父类型异常');const name=str(readIdx(r,ss)),sig=readIdx(r,bs);value=resolve([2,1,26,6,27][tag]*16777216+(parent>>>3),depth+1)+'::'+name+':'+signature(sig,depth+1);}
      else if(t===17){value='sig:'+signature(readIdx(table(t,row),bs),depth+1);}
      else if(t===27){value=signature(readIdx(table(t,row),bs),depth+1,true);}
      else if(t===43){const r=table(t,row),parent=readIdx(r,mdr);value=resolve((parent&1?10:6)*16777216+(parent>>>1),depth+1)+'<'+signature(readIdx(r,bs),depth+1)+'>';}
      else if(t===112){ensure(streams['#US'],'用户字符串流缺失');const r=reader(streams['#US'].data,row),n=compressed(r);ensure(n>0&&n%2===1,'用户字符串异常');value='string:'+utf16.decode(r.bytes(n-1));r.u8();}
      else throw new Error('不支持的元数据引用 '+t);
      caches.set(token,value);return value;
    }
    const methodType=m=>resolve(0x02000000+owner(m.row,'method'));
    function enumValues(name) {
      const values=[];
      for(let i=1;i<=rows[11];i++){
        const r=table(11,i),type=r.u16(),parent=readIdx(r,ci(2,[4,8,23])),value=blob(readIdx(r,bs));
        if((parent&3)!==0)continue;
        const row=parent>>>2;
        if(resolve(0x02000000+owner(row,'field'))===name) values.push([fields[row-1].name,type,hex(value)]);
      }
      return values.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
    }
    const metadataRecord=(t,row)=>{table(t,row);return {at:(streams['#~']||streams['#-']).at+starts[t]+sizes[t]*(row-1),size:sizes[t]};};
    return {bytes,offset,methods,resolve,methodType,signature,cli,streams,enumValues,metadataRecord,rows,fields,typeDefs};
  }
  const tokenOps=new Set([0x27,0x28,0x29,0x6f,0x70,0x71,0x72,0x73,0x74,0x75,0x79,0x7b,0x7c,0x7d,0x7e,0x7f,0x80,0x81,0x8c,0x8d,0x8f,0xa3,0xa4,0xa5,0xc2,0xc6,0xd0,0xfe06,0xfe07,0xfe15,0xfe16,0xfe1c]);
  function instructions(code) {
    const r=reader(code,0,true),d=view(code),out=[];
    while(r.p<code.length){const at=r.p;let op=r.u8();if(op===0xfe)op=0xfe00|r.u8();const arg=r.p;let size=0,kind='';
      if(tokenOps.has(op)){size=4;kind='token';}
      else if(op>=0x2b&&op<=0x37||op===0xde){size=1;kind='branch';}
      else if(op>=0x38&&op<=0x44||op===0xdd){size=4;kind='branch';}
      else if(op===0x45){const n=r.u32();ensure(n<4096,'switch 过大');size=4+n*4;kind='switch';r.p=arg;}
      else if(op>=14&&op<=19||op===31||op===0xfe12||op===0xfe19)size=1;
      else if(op===32||op===34)size=4;
      else if(op===33||op===35)size=8;
      else if(op>=0xfe09&&op<=0xfe0e)size=2;
      else ensure(op===0||op===1||op>=2&&op<=13||op>=20&&op<=30||op===37||op===38||op===42||op>=0x46&&op<=0x6e||op===0x76||op===0x7a||op>=0x82&&op<=0x8b||op===0x8e||op>=0x90&&op<=0xa2||op>=0xb3&&op<=0xba||op===0xc3||op>=0xd1&&op<=0xdc||op===0xdf||op===0xe0||[0xfe00,0xfe01,0xfe02,0xfe03,0xfe04,0xfe05,0xfe0f,0xfe11,0xfe13,0xfe14,0xfe17,0xfe18,0xfe1a,0xfe1d,0xfe1e].includes(op),'未知 IL 操作码');
      r.bytes(size);const targets=[];
      if(kind==='branch')targets.push(r.p+(size===1?d.getInt8(arg):d.getInt32(arg,true)));
      if(kind==='switch')for(let p=arg+4;p<r.p;p+=4)targets.push(r.p+d.getInt32(p,true));
      out.push({at,arg,op,size,kind,end:r.p,targets,token:kind==='token'?d.getUint32(arg,true):null});
    }
    const boundaries=new Set(out.map(x=>x.at));for(const i of out)for(const t of i.targets)ensure(boundaries.has(t),'IL 跳转未对齐指令');return out;
  }

  function locateDll(bundle) {
    const needle=enc.encode('HotUpdate.dll'),candidates=[];
    for (const node of bundle.nodes) {
      const a=bundle.data.subarray(node.offset,node.offset+node.size),d=view(a);let p=0;
      while ((p=find(a,needle,p))>=0) {
        const n=p++; if(n<4||d.getUint32(n-4,true)!==needle.length) continue;
        const lenAt=align(n+needle.length,4);if(lenAt+6>a.length)continue;
        const size=d.getUint32(lenAt,true),start=lenAt+4;
        if(size<128||start+size>a.length||a[start]!==77||a[start+1]!==90)continue;
        const pe=parsePE(a.subarray(start,start+size));candidates.push({start:node.offset+start,size,pe});
      }
    }
    ensure(candidates.length===1,'HotUpdate.dll 未唯一定位');return candidates[0];
  }
  // Read only the layouts that the writer knows how to preserve.
  function peLayout(bytes) {
    const d=view(bytes);slice(bytes,0,64);
    const u16=p=>{slice(bytes,p,2);return d.getUint16(p,true);};
    const u32=p=>{slice(bytes,p,4);return d.getUint32(p,true);};
    const p=u32(60);ensure(u16(0)===0x5a4d&&u32(p)===0x4550,'缺少 PE 标头');
    const opt=p+24,os=u16(p+20),count=u16(p+6),magic=u16(opt);
    const dirBase=magic===0x10b?96:magic===0x20b?112:0;
    ensure(dirBase&&count>0&&count<=32&&os>=dirBase,'PE 可选头异常');slice(bytes,opt,os);
    const fa=u32(opt+36),sa=u32(opt+32),headers=u32(opt+60);
    const power=x=>x>0&&Number.isInteger(Math.log2(x));
    ensure(power(fa)&&power(sa)&&sa>=fa&&(sa>=4096?fa>=512&&fa<=65536:sa===fa),'PE 对齐参数异常');
    ensure(headers%fa===0&&headers<=bytes.length&&opt+os+count*40<=headers,'PE 节表越界');
    const sections=[];
    for(let i=0;i<count;i++){
      const at=opt+os+40*i,s={at,used:u32(at+8),va:u32(at+12),size:u32(at+16),raw:u32(at+20),flags:u32(at+36)};
      ensure(s.va%sa===0&&s.va>=align(headers,sa)&&s.size%fa===0,'PE section 对齐异常');
      if(s.size){ensure(s.raw>=headers&&s.raw%fa===0,'PE raw 对齐异常');slice(bytes,s.raw,s.size);}
      ensure(s.va+Math.max(s.used,s.size)<=0xffffffff,'PE RVA 溢出');
      for(const t of sections){
        ensure(!s.size||!t.size||s.raw+s.size<=t.raw||t.raw+t.size<=s.raw,'PE raw section 重叠');
        ensure(s.va+align(Math.max(s.used,s.size),sa)<=t.va||t.va+align(Math.max(t.used,t.size),sa)<=s.va,'PE virtual section 重叠');
      }
      sections.push(s);
    }
    const n=u32(opt+dirBase-4);ensure(n<=16&&dirBase+n*8<=os,'PE 数据目录越界');
    const directories=Array.from({length:n},(_,i)=>({rva:u32(opt+dirBase+i*8),size:u32(opt+dirBase+i*8+4)}));
    const offset=(rva,length=1)=>{
      ensure(Number.isSafeInteger(rva)&&Number.isSafeInteger(length)&&length>=0,'PE 地址异常');
      const s=sections.find(s=>rva>=s.va&&rva+length<=s.va+s.size);
      ensure(s,'CLI 地址越界');return s.raw+rva-s.va;
    };
    const imageEnd=align(Math.max(headers,...sections.map(s=>s.va+Math.max(s.used,s.size))),sa);
    ensure(u32(opt+56)>=imageEnd&&u32(opt+56)%sa===0,'PE SizeOfImage 异常');
    return {p,opt,os,count,magic,fa,sa,headers,sections,directories,offset,imageEnd};
  }

  // Normalize EH clauses to the fat encoding, so adding a prefix cannot wrap
  // a small clause's 16-bit offsets. Original method bytes remain immutable.
  function readEH(bytes,codeAt,codeLength,shift=0) {
    const at=align(codeAt+codeLength,4);slice(bytes,at,4);
    const kind=bytes[at],fat=!!(kind&64),d=view(bytes);
    ensure((kind&63)===1&&!(kind&128),'不支持的 CLI 异常节链');
    const length=fat?(bytes[at+1]|bytes[at+2]<<8|bytes[at+3]<<16):bytes[at+1],stride=fat?24:12;
    ensure(length>=4&&(length-4)%stride===0,'CLI 异常节长度异常');slice(bytes,at,length);
    const count=(length-4)/stride,out=new Uint8Array(4+count*24),v=view(out);
    ensure(out.length<=0xffffff,'CLI 异常节过大');out[0]=0x41;out[1]=out.length&255;out[2]=out.length>>>8&255;out[3]=out.length>>>16;
    for(let i=0;i<count;i++){
      const q=at+4+i*stride,z=4+i*24;
      const flags=fat?d.getUint32(q,true):d.getUint16(q,true);
      const ts=fat?d.getUint32(q+4,true):d.getUint16(q+2,true),tl=fat?d.getUint32(q+8,true):bytes[q+4];
      const hs=fat?d.getUint32(q+12,true):d.getUint16(q+5,true),hl=fat?d.getUint32(q+16,true):bytes[q+7];
      let token=d.getUint32(q+(fat?20:8),true);
      ensure([0,1,2,4].includes(flags)&&ts+tl<=codeLength&&hs+hl<=codeLength,'CLI 异常处理范围异常');
      if(flags===1){ensure(token<codeLength,'CLI filter 越界');token+=shift;}
      for(const [j,value] of [flags,ts+shift,tl,hs+shift,hl,token].entries()){
        ensure(value>=0&&value<=0xffffffff,'CLI 异常偏移溢出');v.setUint32(z+j*4,value,true);
      }
    }
    return {bytes:out,end:at+length};
  }

  function methodExtent(pe,m) {
    const at=pe.offset(m.rva),d=view(pe.bytes),first=pe.bytes[at];let codeAt,length,flags;
    if((first&3)===2){flags=2;codeAt=at+1;length=first>>>2;}
    else {slice(pe.bytes,at,12);flags=d.getUint16(at,true);const hs=(flags>>>12)*4;ensure((flags&3)===3&&hs>=12,'CLI 方法头异常');codeAt=at+hs;length=d.getUint32(at+4,true);}
    slice(pe.bytes,codeAt,length);const end=flags&8?readEH(pe.bytes,codeAt,length).end:codeAt+length;
    ensure(pe.offset(m.rva,end-at)===at,'CLI 方法跨 section');return {at,codeAt,length,end};
  }

  // SerializedFile v17..22: leave metadata and all non-target object payloads
  // intact; only update the TextAsset size and the offsets after its insertion.
  function serializedLayout(bytes){
    slice(bytes,0,20);const d=view(bytes),version=d.getUint32(8,false);
    ensure(version>=17&&version<=22,'不支持扩容此 SerializedFile 版本：'+version);
    const extended=version>=22,header=extended?48:20;slice(bytes,0,header);
    const size=extended?Number(d.getBigUint64(24,false)):d.getUint32(4,false);
    const dataAt=extended?Number(d.getBigUint64(32,false)):d.getUint32(12,false);
    const metadataSize=d.getUint32(extended?20:0,false);
    ensure(size===bytes.length&&dataAt>=header+metadataSize&&dataAt<=size,'SerializedFile 长度异常');
    ensure(bytes[16]===0||bytes[16]===1,'SerializedFile 字节序异常');const le=bytes[16]===0;
    const r=reader(slice(bytes,0,header+metadataSize),header,le);r.str(256);r.u32();const tree=r.u8();ensure(tree<=1,'类型树标志异常');
    const count=r.u32();ensure(count<=100000,'SerializedFile 类型过多');const types=[];
    for(let i=0;i<count;i++){
      const classID=r.u32();types.push(classID);r.u8();r.u16();if(classID===114)r.bytes(16);r.bytes(16);
      if(tree){const nodes=r.u32(),strings=r.u32();ensure(nodes<=1000000&&strings<=LIMIT,'类型树长度异常');r.bytes(nodes*(version>=19?32:24));r.bytes(strings);if(version>=21){const n=r.u32();ensure(n<=100000,'类型依赖过多');r.bytes(n*4);}}
    }
    const n=r.u32();ensure(n>0&&n<=1000000,'SerializedFile 对象数异常');const objects=[];
    for(let i=0;i<n;i++){
      r.p=align(r.p,4);r.bytes(8);const offsetAt=r.p,offset=extended?r.u64():r.u32(),sizeAt=r.p,length=r.u32(),type=r.u32();
      ensure(type<types.length&&dataAt+offset+length<=size,'SerializedFile 对象越界');objects.push({offsetAt,sizeAt,start:dataAt+offset,size:length,classID:types[type]});
    }
    const sorted=objects.slice().sort((a,b)=>a.start-b.start);for(let i=1;i<sorted.length;i++)ensure(sorted[i-1].start+sorted[i-1].size<=sorted[i].start,'SerializedFile 对象重叠');
    return {version,extended,dataAt,le,objects};
  }

  function repackResized(bundle,data){
    ensure(data.length<=LIMIT&&data.length>0,'扩容资源长度异常');const chunk=1024*1024,blocks=Math.ceil(data.length/chunk);
    const names=bundle.nodes.map(n=>enc.encode(n.name+'\0'));
    const info=new Uint8Array(16+4+blocks*10+4+names.reduce((n,x)=>n+20+x.length,0)),v=view(info);let p=16;
    v.setUint32(p,blocks,false);p+=4;
    for(let i=0;i<blocks;i++){const size=Math.min(chunk,data.length-i*chunk);v.setUint32(p,size,false);v.setUint32(p+4,size,false);v.setUint16(p+8,0,false);p+=10;}
    v.setUint32(p,bundle.nodes.length,false);p+=4;
    bundle.nodes.forEach((n,i)=>{ensure(n.offset+n.size<=data.length,'UnityFS 新目录项越界');v.setBigUint64(p,BigInt(n.offset),false);v.setBigUint64(p+8,BigInt(n.size),false);v.setUint32(p+16,n.flags,false);p+=20;info.set(names[i],p);p+=names[i].length;});
    const flags=bundle.flags&~63,h=bundle.base+align(bundle.headerEnd-bundle.base,16);
    let dataAt=flags&128?h:h+info.length;if(flags&512)dataAt=bundle.base+align(dataAt-bundle.base,16);
    const infoAt=flags&128?dataAt+data.length:h,total=flags&128?infoAt+info.length:dataAt+data.length;ensure(total<=LIMIT,'重打包资源过大');
    const out=new Uint8Array(total);out.set(bundle.bytes.subarray(0,bundle.headerEnd));const d=view(out);
    d.setBigUint64(bundle.sizeAt,BigInt(total-bundle.base),false);d.setUint32(bundle.sizeAt+8,info.length,false);d.setUint32(bundle.sizeAt+12,info.length,false);d.setUint32(bundle.sizeAt+16,flags,false);
    out.set(info,infoAt);out.set(data,dataAt);return out;
  }

  function replaceLanguageTable(source,translations={}) {
    const input=unpack(source),decoder=new TextDecoder('utf-8',{fatal:true});
    const candidates=[];
    for(const node of input.nodes){
      const file=slice(input.data,node.offset,node.size),layout=serializedLayout(file),d=view(file);
      for(const obj of layout.objects){
        if(obj.classID!==49)continue;
        const nameLength=d.getUint32(obj.start,layout.le),nameAt=obj.start+4;
        if(nameLength>256||nameAt+nameLength>obj.start+obj.size)continue;
        const name=decoder.decode(slice(file,nameAt,nameLength));
        if(name!=='Language')continue;
        const sizeAt=align(nameAt+nameLength,4),payloadAt=sizeAt+4;
        ensure(payloadAt<=obj.start+obj.size,'Language TextAsset 头部异常');
        const size=d.getUint32(sizeAt,layout.le);
        ensure(size>8&&payloadAt+size<=obj.start+obj.size,'Language TextAsset 内容越界');
        const tail=obj.start+obj.size-(payloadAt+size);
        ensure(tail>=0&&tail<=7&&obj.size%4===0&&slice(file,payloadAt+size,tail).every(x=>x===0),'Language TextAsset 尾部布局变化');
        candidates.push({node,file,layout,obj,sizeAt,payloadAt,size});
      }
    }
    ensure(candidates.length===1,'Language TextAsset 未唯一定位');
    const {node,file,layout,obj,sizeAt,payloadAt,size}=candidates[0],body=slice(file,payloadAt,size),d=view(body);
    const rows=d.getUint32(0,false),columns=d.getUint32(4,false);
    ensure(rows>=5&&rows<=100000&&columns===7,'Language 表行列变化');
    let p=8,total=8,changed=0,missing=0,alreadyChinese=0;
    const parts=[];
    for(let i=0;i<rows;i++){
      let cn=null,id=null;
      for(let j=0;j<columns;j++){
        const start=p;ensure(p+2<=body.length,'Language 单元格头越界');
        const length=d.getUint16(p,false);p+=2;
        const cell=slice(body,p,length);p+=length;
        if(i===2&&j===2)ensure(decoder.decode(cell)==='CN','Language 中文列变化');
        if(i===2&&j===3)ensure(decoder.decode(cell)==='JP','Language 日文列变化');
        if(j===0)id=decoder.decode(cell);
        if(j===2)cn=cell;
        if(i>=4&&j===3){
          if(Object.hasOwn(translations,id))cn=enc.encode(translations[id]);
          if(!cn?.length){if(length)missing++;}
          else if(eq(cn,cell))alreadyChinese++;
          else {
            ensure(cn.length<=65535,'Language 中文单元格过长');
            parts.push(new Uint8Array([cn.length>>>8,cn.length&255]),cn);
            total+=cn.length+2;changed++;continue;
          }
        }
        parts.push(body.subarray(start,p));total+=p-start;
      }
    }
    ensure(p===body.length&&(changed>0||alreadyChinese>0)&&total<=LIMIT,'Language 表尾部或替换数量异常');
    const translated=new Uint8Array(total);translated.set(body.subarray(0,8));let cursor=8;
    for(const part of parts){translated.set(part,cursor);cursor+=part.length;}
    ensure(cursor===total,'Language 表重建长度异常');
    const newObjectSize=align(payloadAt-obj.start+translated.length,4);
    const delta=newObjectSize-obj.size,move=align(delta,8);
    ensure(move>=delta&&file.length+move>0&&input.data.length+move<=LIMIT,'Language 扩容长度异常');
    const nextFile=new Uint8Array(file.length+move);
    nextFile.set(file.subarray(0,payloadAt));nextFile.set(translated,payloadAt);
    nextFile.set(file.subarray(obj.start+obj.size),obj.start+obj.size+move);
    const v=view(nextFile);v.setUint32(sizeAt,translated.length,layout.le);v.setUint32(obj.sizeAt,newObjectSize,layout.le);
    if(layout.extended)v.setBigUint64(24,BigInt(nextFile.length),false);else v.setUint32(4,nextFile.length,false);
    for(const other of layout.objects)if(other!==obj&&other.start>=obj.start+obj.size){
      const offset=other.start-layout.dataAt+move;ensure(offset>=0,'Language 对象偏移下溢');
      if(layout.extended)v.setBigUint64(other.offsetAt,BigInt(offset),layout.le);else v.setUint32(other.offsetAt,offset,layout.le);
    }
    const check=serializedLayout(nextFile);
    for(let i=0;i<layout.objects.length;i++){
      const a=layout.objects[i],b=check.objects[i];
      if(a===obj){ensure(b.size===newObjectSize,'Language 对象长度回读不一致');continue;}
      ensure(eq(slice(file,a.start,a.size),slice(nextFile,b.start,b.size)),'Language 以外的游戏对象发生变化');
    }
    ensure(eq(slice(nextFile,payloadAt,translated.length),translated),'Language 文本回读不一致');
    const data=new Uint8Array(input.data.length+move);data.set(input.data.subarray(0,node.offset));
    data.set(nextFile,node.offset);data.set(input.data.subarray(node.offset+node.size),node.offset+nextFile.length);
    const nodes=input.nodes.map(n=>{
      ensure(n===node||n.offset+n.size<=node.offset||n.offset>=node.offset+node.size,'Language UnityFS 目录项重叠');
      return {...n,size:n.size+(n===node?move:0),offset:n.offset+(n.offset>=node.offset+node.size?move:0)};
    });
    const output=repackResized({...input,nodes},data),round=unpack(output);
    ensure(eq(round.data,data),'Language UnityFS 回读不一致');
    const roundFile=slice(round.data,node.offset,nextFile.length),roundLayout=serializedLayout(roundFile);
    ensure(roundLayout.objects.length===layout.objects.length&&eq(roundFile,nextFile),'Language SerializedFile 回读不一致');
    return {bytes:output,proof:{rows,changed,missing,alreadyChinese,sourceBytes:source.length,resultBytes:output.length}};
  }

  async function applyResourcePlan(source,plan) {
    const input=unpack(source),sourceHash=await hash(input.data);
    const plans=Array.isArray(plan)?plan:[plan];
    plan=plans.find(p=>p&&(sourceHash===p.source||sourceHash===p.result));
    let adaptive=false;
    if(!plan){
      adaptive=true;const nodes={},seen=new Set();
      const specs=plans.filter(Boolean).flatMap(p=>Object.values(p.nodes).flat());
      for(const node of input.nodes){
        const file=slice(input.data,node.offset,node.size);let layout;
        try{layout=serializedLayout(file);}catch{continue;}
        const hashes=new Map();
        for(const obj of layout.objects){
          if(!specs.some(s=>s.size===obj.size))continue;
          const digest=await hash(slice(file,obj.start,obj.size));
          if(!hashes.has(digest))hashes.set(digest,[]);hashes.get(digest).push(obj);
        }
        for(const spec of specs){
          const matches=hashes.get(spec.hash)||[];
          if(matches.length!==1)continue;
          const obj=matches[0],key=node.name+':'+obj.start;
          if(seen.has(key)||spec.segments?.some(s=>s.copy)&&obj.start!==spec.start)continue;
          seen.add(key);(nodes[node.name]??=[]).push({...spec,start:obj.start});
        }
      }
      if(!seen.size)return {bytes:source,proof:{adaptive:true,objects:0,skipped:true}};
      plan={nodes,proof:{adaptive:true}};
    }
    if(sourceHash===plan.result)return {bytes:source,proof:{...plan.proof,alreadyApplied:true}};
    if(!adaptive)ensure(sourceHash===plan.source,'资源校验失败');
    const from64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
    const nodeFiles=new Map();let changed=0;
    for(const node of input.nodes){
      const specs=plan.nodes[node.name];if(!specs?.length)continue;
      const file=slice(input.data,node.offset,node.size),layout=serializedLayout(file);
      const replacements=new Map();let growth=0;
      for(const spec of specs){
        const obj=layout.objects.find(o=>o.start===spec.start&&o.size===spec.size);
        ensure(obj,'汉化对象位置变化：'+spec.label);const old=slice(file,obj.start,obj.size);
        ensure(await hash(old)===spec.hash,'汉化对象内容变化：'+spec.label);
        let next;
        if(spec.segments){
          const pieces=spec.segments.map(s=>s.copy?slice(file,s.copy[0],s.copy[1]):from64(s.bytes));
          next=new Uint8Array(pieces.reduce((n,p)=>n+p.length,0));let at=0;
          for(const p of pieces){next.set(p,at);at+=p.length;}
        }else{
          const pieces=[];let cursor=0,total=0;
          for(const part of spec.splices){
            ensure(part.at>=cursor&&part.at+part.remove<=old.length,'汉化文字范围异常');
            const prefix=old.subarray(cursor,part.at),text=from64(part.bytes);pieces.push(prefix,text);total+=prefix.length+text.length;cursor=part.at+part.remove;
          }
          pieces.push(old.subarray(cursor));total+=old.length-cursor;next=new Uint8Array(total);let at=0;
          for(const p of pieces){next.set(p,at);at+=p.length;}
        }
        ensure(next.length>0&&await hash(next)===spec.result,'汉化对象回读失败：'+spec.label);
        replacements.set(obj,next);growth+=align(next.length-obj.size,8);changed++;
      }
      ensure(file.length+growth>0&&file.length+growth<=LIMIT,'汉化资源长度超限');
      const nextFile=new Uint8Array(file.length+growth);let cursor=0,shift=0;
      for(const obj of layout.objects.slice().sort((a,b)=>a.start-b.start)){
        const next=replacements.get(obj);if(!next)continue;
        nextFile.set(file.subarray(cursor,obj.start),cursor+shift);nextFile.set(next,obj.start+shift);
        shift+=align(next.length-obj.size,8);cursor=obj.start+obj.size;
      }
      nextFile.set(file.subarray(cursor),cursor+shift);ensure(shift===growth,'汉化资源偏移异常');
      const d=view(nextFile);if(layout.extended)d.setBigUint64(24,BigInt(nextFile.length),false);else d.setUint32(4,nextFile.length,false);
      shift=0;
      for(const obj of layout.objects.slice().sort((a,b)=>a.start-b.start)){
        if(layout.extended)d.setBigUint64(obj.offsetAt,BigInt(obj.start-layout.dataAt+shift),layout.le);else d.setUint32(obj.offsetAt,obj.start-layout.dataAt+shift,layout.le);
        const next=replacements.get(obj);if(next){d.setUint32(obj.sizeAt,next.length,layout.le);shift+=align(next.length-obj.size,8);}
      }
      const check=serializedLayout(nextFile);ensure(check.objects.length===layout.objects.length,'汉化对象数量变化');
      for(let i=0;i<layout.objects.length;i++){
        const a=layout.objects[i],b=check.objects[i],expected=replacements.get(a)||slice(file,a.start,a.size);
        ensure(b.size===expected.length&&eq(expected,slice(nextFile,b.start,b.size)),'非目标对象变化或回读失败');
      }
      nodeFiles.set(node,nextFile);
    }
    const total=input.data.length+Array.from(nodeFiles,([node,file])=>file.length-node.size).reduce((a,b)=>a+b,0);
    ensure(total<=LIMIT,'汉化资源总长度超限');const data=new Uint8Array(total),nodes=input.nodes.map(n=>({...n}));let cursor=0,shift=0;
    for(const node of input.nodes.slice().sort((a,b)=>a.offset-b.offset)){
      const index=input.nodes.indexOf(node),file=nodeFiles.get(node)||slice(input.data,node.offset,node.size);
      data.set(input.data.subarray(cursor,node.offset),cursor+shift);data.set(file,node.offset+shift);
      nodes[index].offset=node.offset+shift;nodes[index].size=file.length;shift+=file.length-node.size;cursor=node.offset+node.size;
    }
    data.set(input.data.subarray(cursor),cursor+shift);
    if(plan.result)ensure(await hash(data)===plan.result,'资源汉化回读哈希不一致');
    const bytes=repackResized({...input,nodes},data);ensure(eq(unpack(bytes).data,data),'资源重打包回读失败');
    return {bytes,proof:{...plan.proof,objects:changed,sourceBytes:source.length,resultBytes:bytes.length,resultHash:await hash(data)}};
  }

  function patchAssemblyLanguage(source,translations) {
    const input=unpack(source),descriptor=locateDll(input),pe=descriptor.pe;
    const patched=pe.bytes.slice();let guardFixed=false,guardChanged=false,displayMessages=0;
    const guard=pe.methods.find(m=>m.rva&&methodTypeName(pe,m)==='Table.LanguageTable'&&m.name==='IsUnresolvedJapaneseText');
    if(guard){
      ensure(pe.signature(guard.sig)==='0:0:p2(p14,18:Table.LanguageConfig)','文字校验函数签名变化');
      const body=methodExtent(pe,guard),ops=instructions(pe.bytes.subarray(body.codeAt,body.codeAt+body.length));
      const calls=ops.filter(i=>i.op===0x28&&pe.resolve(i.token).startsWith('Table.LanguageTable::ContainsSimplifiedChineseMarker:'));
      ensure(calls.length<=1,'文字校验函数结构变化');
      if(calls.length){
        // Replace the Chinese-copy rejection with false. Keep the existing empty/placeholder checks.
        patched.set([0x26,0x16,0,0,0],body.codeAt+calls[0].at);guardChanged=true;
      }
      guardFixed=true;
    }
    const stream=pe.streams['#US'];ensure(stream,'程序显示文字流缺失');
    const r=reader(stream.data,1,true),changed=[];
    const compress=n=>n<128?new Uint8Array([n]):n<16384?new Uint8Array([(n>>>8)|128,n&255]):new Uint8Array([(n>>>24)|192,(n>>>16)&255,(n>>>8)&255,n&255]);
    while(r.p<stream.size){
      const start=r.p,n=compressed(r);if(!n)continue;
      ensure(n%2===1&&r.p+n<=stream.size,'程序字符串长度异常');
      const text=utf16.decode(r.bytes(n-1));r.u8();
      if(!Object.hasOwn(translations,text))continue;
      const next=translations[text],bytes=new Uint8Array(next.length*2),v=view(bytes);
      for(let i=0;i<next.length;i++)v.setUint16(i*2,next.charCodeAt(i),true);
      const length=compress(bytes.length+1),total=length.length+bytes.length+1;
      ensure(total<=r.p-start,'中文显示提示超过原空间');
      const at=stream.at+start;patched.fill(0,at,stream.at+r.p);patched.set(length,at);patched.set(bytes,at+length.length);patched[at+total-1]=1;
      changed.push({token:0x70000000+start,text:next});displayMessages++;
    }
    const verify=parsePE(patched);for(const c of changed)ensure(verify.resolve(c.token)==='string:'+c.text,'中文显示提示回读失败');
    if(guard){const body=methodExtent(verify,verify.methods[guard.row-1]);instructions(patched.subarray(body.codeAt,body.codeAt+body.length));}
    if(!guardChanged&&!displayMessages)return {bytes:source,proof:{category:'assembly',chineseValidationFixed:guardFixed,alreadyApplied:true,displayMessages:0}};
    const data=input.data.slice();data.set(patched,descriptor.start);
    const bytes=repack(input,data);ensure(eq(unpack(bytes).data,data),'程序汉化重打包回读失败');
    return {bytes,proof:{category:'assembly',chineseValidationFixed:guardFixed,guardChanged,displayMessages,sourceBytes:source.length,resultBytes:bytes.length}};
  }
  function methodTypeName(pe,m){return pe.methodType(m);}

  return Object.freeze({patchAssemblyLanguage,applyResourcePlan,ensure,eq,hex,hash,enc,view,slice,reader,compressed,unpack,repack,parsePE,instructions,lz4,locateDll,peLayout,readEH,methodExtent,serializedLayout,replaceLanguageTable});
}

const uiPatchPool=[{"size":164,"label":"UI text/font","hash":"c5b817fff573f8e1d5d13b35f9566b6cc2a587edd0a89f108a088f47d46be320","result":"792be61af8a3fd1b33ab38a43af0defdb291b459633b991a4653dcca35e3b9b1","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWxnuaApwA="}]},{"size":164,"label":"UI text/font","hash":"3ed47dfbd5498f57ea7cd5e24aa45d30989619051537cbd2d1658061bfaf9fbc","result":"d4f13b5c5418e36c9ee76078d6945a1336fda4ac1d48d74df2bdc5c352d56501","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":172,"label":"UI text/font","hash":"caeacd513e39c3c6c5badffa568ce538880909d2fcdbefe55be2a61b1c8155c1","result":"c536a56894cc848de4164673fcaa5cfde613f5dadf78d4f0538ca546cb2d88a3","splices":[{"at":144,"remove":20,"bytes":"DAAAAOW9k+WJjeeKtuaAgQ=="}]},{"size":156,"label":"UI text/font","hash":"b5d9e198aae46e8d6fd5aecbb50422dfc04f41504d9c226724cb6fc2499099bc","result":"f9d7968a2df42ab72ed8876a83189ee5eb5976199de22f18adac092a0618dc6c","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"ae7aaf3b16949d43125a02d65dab0fedfe182eee63be2fb1ea6a3ed41c647c75","result":"cea499c3d79b93ca2fc3f524fe721a0541606b2f8b076c598abbca96f166d0a2","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":152,"label":"UI text/font","hash":"9d582b9dbedf31a0bb41937e34c613c34e739be2c445c8fbd63a2f1db41b25b3","result":"e7e6d4415c5a65d4f513d6998c6c8d43d9d8e7c4b06371119f9fc0facdbe2d00","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":260,"label":"UI text/font","hash":"3360744c7c3d1d890a39b893b9fd66370dd9ba368aa1fe1ec29bbd74f8e9491a","result":"110c7ba2096a7bda81c4843adfb6eb7d5791d30f7109aa4efb9c1cd7e5e70453","splices":[{"at":144,"remove":105,"bytes":"RAAAAOe7iOS6juadpeWIsOi/memHjOS6hu+8gQrmnaXlkKfvvIzljrvjgIzphZLppobjgI0K6L+O5o6l5LyZ5Ly05ZCn"}]},{"size":176,"label":"UI text/font","hash":"9fa12599832ada873b64d95925f2158fa4228de89431563d510bfdb838f0e3df","result":"a128caa64e014430c73534ffb7353a9a58ae5cfb8f71aa1219f17834eeaf9bc5","splices":[{"at":148,"remove":18,"bytes":"6YCa6L+H5oiY5paX6Kej6ZSB"}]},{"size":188,"label":"UI text/font","hash":"80878ae0d55823f54360a0784ea23ee01eac3896023d04ff61037290b2301f91","result":"c3b07dc21f33f1f715d37a57dc64ce1e74063aa92ded4f681760b42e0173440a","splices":[{"at":92,"remove":88,"bytes":"thhU33YkmC8kAAAAAAAAAAAAAAAKAAAAKAAAAAQAAAAAAAAAAQAAAAAAAAAAAAAAAACAPwwAAADpmpDnp4HmlL/nrZY="}]},{"size":192,"label":"UI text/font","hash":"ee75c851be8c2b7b37b2fe8ab82fcd7e95c61c4740ea508a8b785d63ea135745","result":"c7e73b43fc40cfcc5df0f66a39dac4bbbda7716d1252aaac7b264a19b1ab1d4d","splices":[{"at":144,"remove":46,"bytes":"FQAAAOivt+i+k+WFpeaCqOeahOWvhueggQA="}]},{"size":164,"label":"UI text/font","hash":"58d68bf897f933a008fefc0705f324a9c457298bf66e9f323f636fca90a2d430","result":"9349833609c6ab29c419052cf9b5ffda96a16586d517aa5084dc29cfe186bc47","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWxnuaApwA="}]},{"size":192,"label":"UI text/font","hash":"5f0c9f242caac73ee9d02f53735c60d336f0e5e4478b59f7bbe4d6afc374b208","result":"e8c09430c8e307d16c63af13495cd5c55e53da92b820a0d205045c7563d0ab25","splices":[{"at":92,"remove":92,"bytes":"thhU33YkmC8jAAAAAAAAAAAAAAACAAAA/gAAAAQAAAAAAAAAAQAAAAAAAAAAAAAAAACAPxgAAADnibnku7fllYblk4Hlt7Lmm7TmlrDvvIE="}]},{"size":160,"label":"UI text/font","hash":"a935da2ff73124ce44e5c10787d31a86f5cf9a3af216747e6d654081c893da87","result":"43d2634c7c28f07235b1d5f75f264a5c4135de04a87b84c77c505894a92aab4d","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"f6e191631058570e31c11126de302ebd0140a570a0e69aab6505b36adc432e4c","result":"043a7b66bcce2f02d96d3f1921f18620c7431994285055e689736fe7a2c7b9db","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"3dccaa7e336e90400e24bbc49c52c7acd80852af781e0e0140e5f3e03e578873","result":"f147284ed05df7e53cbd2ffdc5beca6c3893ce4780002e0080e16a50141d9c45","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"7e7f93be645f3e133571975b4fb922dca8e0320046e57b3747e1bcb2821f2555","result":"e45af84665acbb25a707f5f1de5b2acbe0e0c4c6d0f8957ffdc4b82cb4871b52","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"913247f4121f205cb03ea2f943ec9879a4908995da3f2426ed276ef5e706c5fa","result":"9226794e0539e14ac7982d6bc712da8fae24733f994483b4375429d66aa74cf4","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"127d68c1b64e38ea96ab4a745554b8df6c06b10cede044eb1726878c47d4e24a","result":"0fc732bc3792c7d897fe0a76013ba6b26208c3638695c0746eca9bc262b9f2e2","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"0777239be5b6ed08628546ef49b82c488f78b7d5cdf34940505f350867c76077","result":"efb30a5e5e4d3ae649ff43aac321f47447fcb17fe869df3d3da7a8c9b2379b0b","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"8c277b09bb39ef3c0d487204a754efd7d3c43a2c47bdac0e61a8c6a07fdd0a4c","result":"d9f9799b574ee1839d312c265ff4a09c0b36975ac93aec4069e2481a21e49ae7","splices":[{"at":144,"remove":28,"bytes":"DAAAAOinkuiJsuWQjeensA=="}]},{"size":156,"label":"UI text/font","hash":"b101f8c33f6cf2090b7d8ba16110577b6443d5f4fbdda2c72ff16c577daeacac","result":"ac561089d621fa00a73c2bce35f4d58643438068f7226b10acbfea327a419823","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"1dff8b64a02c542b9070d22cf0310565b8689fabc6ea83aab48cecd3ddbba138","result":"c06b830163a15f95a4d7b963d7138489ecc8919ffca0ca65e66e254c7d77202e","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"5c32903f095a08babd21ea88da8624da6a502f7ea883e280b4ffa916c91c4aa9","result":"3bef90eb7a243c68d9ab3c171f083301e400e7ca38c457772abcb4f6624c8280","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"032bfb8473fa961487d68f865b422a822cf6b6a227d7e05016cde5e8f90fa4db","result":"30f3d03b32011e33f3f79581a1831a1708b7e9daa901519b2aa49d83992d4ee6","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"36576cc095cf1ba408c761a5e8007aaa2f40172b34176604ec4d5801afdc2d29","result":"2c8558ec358f40c2ce4fc40e08f87fdbabce39c66f471bff3c35c81072baffa7","splices":[{"at":144,"remove":28,"bytes":"DAAAAOinkuiJsuWQjeensA=="}]},{"size":164,"label":"UI text/font","hash":"c94b4ebc14a37b6e57ea26442bffee97dcb502be6525e47eb5c449883d80ccdd","result":"957a3142fddbdffd2225c19f03c77d5cd270c7b51568123e070b669793f8f5c7","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWxnuaApwA="}]},{"size":168,"label":"UI text/font","hash":"a0c5dfad0a075781f5cea5f281fb99f58e6cbc2a6f59c0d94a6b4ee339dabcad","result":"06bc0e7550f625d7d0e7cab7e71c1f243a3b6484867f6cd782229255ecf12761","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"4250364f626d25533982645d7ce93219b64ebd1b891854ff2c7c5132d13aeac9","result":"247ced8b0163f703873bb4311f7f2b98af2ec0a6e7427a928f7fd9a1195196fc","splices":[{"at":144,"remove":28,"bytes":"DAAAAOinkuiJsuWQjeensA=="}]},{"size":156,"label":"UI text/font","hash":"bf94856e0e0f3bef4e7f8fd78bfc0eb194c79c1305e1e1ad5505a8cc29ed5ece","result":"d5029bc82c0567cc0a479ae6749aa98e6883fe7fc98ae2ea381fbab6ad90c7f7","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"7cdf1607a65e7f80a6d084f0dec8f262aaf72d00aa497e77af31c2e3467e6540","result":"3367a5f871382717b07f3788058889e91d976a99c012bdc1ac71aff98a81bee5","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"1304acf0e51e6d67a772c1df81189700c707a5e1747860578048735d5de10be2","result":"7803b16f2686c83a81430071a54842e5dc5ba36e120cccc0a9ad6600e173b00d","splices":[{"at":144,"remove":28,"bytes":"EgAAAOehruiupOaBouWkjeS9k+WKmwAA"}]},{"size":168,"label":"UI text/font","hash":"dd7c674347e105920f084a77b0a001a97a4095c0010ec495df78ad74d561ce7f","result":"6995e55b5317941c140980ba7634bb10f8c44eed42e05c55aba1e5ae25b91c53","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":172,"label":"UI text/font","hash":"65e941426d76b30086335a9e6feff4ecc82478b9e09b5da6de844500d5af551e","result":"4abad88ea6464fdd86cb34ab8afcb6f753ebd0735b9a9014bc91b20698dcdfed","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWPlua2iAA="}]},{"size":168,"label":"UI text/font","hash":"f40e1761d32435748c3cf560ce05eba7ffb014e3c65c62f67ec40101684aa11c","result":"5c5fa2dd89ea3baec8a54f0a8eb6b32539506610eeec0e79d95f705f50ff3525","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":1112,"label":"UI text/font","hash":"48204d9f615ab7540bcfd3ceef4bef63f4ca927f7dcd6845efe3322451d58141","result":"1ddcd1eb1e97d662f43cd973542560965cf467deaa4be82ba19dbb52ea0199a3","splices":[{"at":144,"remove":959,"bytes":"WwIAACLmr4/mrKHmir3lj5blnYfmjInnhaflkITop5LoibLorr7lrprnmoTmj5DkvpvmpoLnjofov5vooYzjgIIKIOWkmuasoeaKveWPluaXtu+8jOS5n+S8muS+neaNruaPkOS+m+amgueOh+mAkOasoeaKveWPluOAggog55Sx5LqO572R57uc6YCa5L+h54q25Ya15oiW5YW25LuW5Y6f5Zug77yM5oq95Y2h5ryU5Ye65Y+v6IO96KKr6Lez6L+H77yMCiDmiJbml6Dms5XmraPluLjmmL7npLrvvIzkvYbop5LoibLlkozmir3ljaHku6PluIHku43kvJrmraPluLjojrflvpfjgIIKIOiBlOezu+WuouacjeWJje+8jOivt+WFiOafpeeci+ebuOW6lOeahOiOt+W+l+iusOW9leOAggog5ZCM5LiA5Z+656GA6KeS6Imy55qE5LiN5ZCM5b2i5oCB5peg5rOV5ZCM5pe257yW5YWl6Zif5LyN77yM5pWs6K+35rOo5oSP44CCCiDmir3ljaHlj6/og73ph43lpI3ojrflvpfnm7jlkIzop5LoibLjgIIKIOmHjeWkjeiOt+W+l+W3suaLpeacieeahOinkuiJsuaXtu+8jOS8muiHquWKqOi9rOaNouS4uuWvueW6lOinkuiJsueahOeijueJh+OAgQog6KeS6Imy57uP6aqM5b6956ug562J6YGT5YW344CCCiDmr4/ml6XkuIDmrKHnmoTmipjmiaPmir3ljaHkuo7mr4/lpKk1OjAw6YeN572u44CCIg=="}]},{"size":172,"label":"UI text/font","hash":"2332f9aa876a142dae53afb5a32d85626956dc32224beeb3acd4dba9e2e77de9","result":"95e4a503ab8d48ea5d2f1a03055ebeddcf74b2f85aa7ee58ecb24a718952bc6c","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"02fce8213eabc3afa8fe20b7386a30df73bf226cdbce5cbd40d7587de3996f91","result":"ffaf98730edee7ea1ce1754424f986a60a997d2d0c868414bbab2d2e08808253","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"815bdc8b3d8ea0ca4c04d3f61232f9b0b8c1a9087a1b2254bbf7e1c653e53a1d","result":"f480435c2a0c70b5bd9684cec271ee2b88605888959c07d2787ea19c6e0129b3","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"8481647af5263774e16717666a91046aa62d63b356076cf32178593a9442ab73","result":"a4807b0da15ea7aebf51591f6b8c55d8dd2bf9890cc65448fe7141ee1c207951","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"150936b6053143e7e5bdfa141b54b8e14445725f3ed8a5e21b5c40327340a7c2","result":"042d5f3adb0dbbfd1769287526132086a7ed3e8abcb8a809942d23b75ede5733","splices":[{"at":144,"remove":16,"bytes":"BgAAAOeBq+iKsQAA"}]},{"size":156,"label":"UI text/font","hash":"fbdf1f25b114cd36f3e62a7f5b750a121c6490b78fb6bd4b1de6b283fc7cc984","result":"3be53b3db9348cd95c61ac96531dee5f7cfa72b03adf6895ecaae14462c48cfc","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"593f7d97878ac2e51ea09f2fd70e67ae8ddf8e2e742944a51ca533b67da8d3b4","result":"cec315343c32e4466389234415eb18111f0be94de3cc8da401ff656ab90ff778","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"db87d0e4fb0a50b6dc44fca80bbb4d7bd722cd0148d62e2396c9d49b45a01756","result":"ad2ca61cf3549551a7c7cb72ec42dee8b70f61813c3029905bed1a7b5283e383","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"98d070626049d9c7e5619510c0833532044f59efa299a9e821d8abb7debfbbff","result":"4ee0308fbdf30e863c8c2ff5822df7a0f45ed368fbcdb4bf2a1f3356ec02cab8","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":188,"label":"UI text/font","hash":"c982b9704ca889b52eb3274ab5d4bd7aa20906c2a00408479ca0322c6ec0dfa6","result":"654eae8588a29346b77c8cf7d561130074a4331f63a7b82c9bd35ce48dae7128","splices":[{"at":144,"remove":34,"bytes":"FQAAAOadgOaJi+Wkp+W4iOOAkOWkp+OAkQA="}]},{"size":156,"label":"UI text/font","hash":"038802fbcc29819484a3aacc9b3ee05d9b897312ee951384fd31f0303b88f37c","result":"f7e38435294d371528d7698ad5bd5998e9d751602b463440ab0e23dff8f649f7","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"75681e8415bbe945531865372140d04d91e76876d1cfbbf95cae1f5f4876c374","result":"880e5f0e82fe9484fe31795d8557ba0932dec9679e8cc1d2070303c2a011e87e","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":216,"label":"UI text/font","hash":"cb7efb506cd77085c1ad993d7c2f5f0c26fa9f8d15e57224dba77a22e76639a5","result":"b5e78b88727f6a228b3899524ffb10c7dd06a1aa1c0ed76b75cb36159ee94521","splices":[{"at":144,"remove":64,"bytes":"NgAAAOagueaNruW3suijheWkh+eahOOAjOiagOOAjeaVsOmHj++8jOiOt+W+l+ezu+WIl+aViOaenAAA"}]},{"size":196,"label":"UI text/font","hash":"b8a764ed41aec38ad2ebfa671ca37d62a4185dddb9bf17bacb881296e9ee2513","result":"1d224f842859eb48087100a026c14a3fe677d2c5341a795dd15d72f88b1081f3","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"f11714c329e7933f439cb06eb3e249cc919b09b8c42700c8f40be88e82646ccc","result":"fb554974cada3fa6bf6d1b93e4a757a19810f90a8b2fa100fe6514f149efb683","splices":[{"at":144,"remove":25,"bytes":"CQAAAOW5uOi/kOaYnw=="}]},{"size":164,"label":"UI text/font","hash":"b617f606660f7c9e1b780a953fd4a03183923a89af1e6cf3d7a0797376fe79c4","result":"b5af4ee183f49258962fedc85c0cd463d4968016b1d532ad240cd241882a8695","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":292,"label":"UI text/font","hash":"442269d4923952d517f1731b5771abc7419017398f1395f766df3bf5c92ae7ab","result":"362eba9fc392e55bd6663b3197836358a8264a65256f10afa6c073ac34237e08","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"4256fddfb0b152f9f6f7860276c379c874dfb887bba666339ddcc05c61402539","result":"ca966c36ba0ad3131c54194be8b2295997fdd3cc060d6966e676bb433e779a30","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":184,"label":"UI text/font","hash":"037fa7f975a85a12d7ff0239e873701ea6e345722f0841bf1f9c4b2c534ba056","result":"38a14db83f3b7220e18e022633f9cd6f99907c0768c1d48188e0182630056d10","splices":[{"at":92,"remove":83,"bytes":"thhU33YkmC8jAAAAAAAAAAAAAAADAAAAIwAAAAMAAAAAAAAAAQAAAAEAAAAAAAAAmpmZPw8AAADmjIHmnInlubjov5DmmJ8="}]},{"size":160,"label":"UI text/font","hash":"3f487eafec715c0fc3cef0f1f8d79f4c4ed0dcb3b751157a88e4754f81b25ae6","result":"dc32774139c93db2ce35a1698e1fde21ccbddcc08b3b552beb0132d0651b514f","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"420965b811e0523aa0a33ba03467c2816281776c13bec9471d401a4c916139a4","result":"ee6cd6270a84ff0bfeaa71116796f41cec76b8d112c058f2a8d82c7f2f42f3c3","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":172,"label":"UI text/font","hash":"d913bad1c368861deccde9e5577b1832462e67f797eb8225eb81502fe3411995","result":"38d7d06061d94840e5cb397b07f92a260c3bf5c5751c5ed562cf5cc76281594c","splices":[{"at":144,"remove":20,"bytes":"DAAAAOearuiCpOWQjeensA=="}]},{"size":168,"label":"UI text/font","hash":"6f8f6eec115ebef38c5912fd78d8af46cdd02963eafa93959d72b163869d0873","result":"fdb5307ee96e3225fd9896ce51af27e9bb67d334b1e7cc21a35f66428c7cc1ba","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"56b8cb844265eab3d46b0168eaa436d2daf934a9375c595cd6f1f212e48bd578","result":"6f45a096c5d9b980304779db8f9540781d43a61f09e0c143fffd7cd1dbd716fa","splices":[{"at":144,"remove":14,"bytes":"BgAAAOa2iOiAlw=="}]},{"size":160,"label":"UI text/font","hash":"335bcda2f943365b9a2f954e738a5c0e098d5732d20a6632b721b1b7a1779d8e","result":"e17bd8a78d8a3401592998172b75b665bd0e12d707b089a3179de4a014833662","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":196,"label":"UI text/font","hash":"7c9483023438a3b4ddd2d13dd72a55c3a667260bb1b74e0d540212332ff15fa0","result":"bfb54f2654e359d5bf4218a7e138220d68dc2226821bef9aadfdecd938b954cb","splices":[{"at":144,"remove":43,"bytes":"DwAAAOaBtueBtemAgOaVo++8gQ=="}]},{"size":164,"label":"UI text/font","hash":"b8cb8c9c889cc3d98528d69f49253e49f293095e37c9909d20dacce2bd6bfa84","result":"56edc0e0d5a864305a909678b7db40983a8ca366441ef62cf74f1605e3db94a0","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":196,"label":"UI text/font","hash":"89223e0c093ba41b11f3438b4043d4c8a5d8d5c1a2e7336dbb72aca07a1d8aa6","result":"20774c427de2a79e5e7f6e0e814c067f2e81e062982d08a55f836ad3c067658a","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"5b048b4c9f4e9cc59eb935720e9aae243902337b3b186bda7c35812a0a8c80d9","result":"03ba159884b37389d009429f491b7b365f3ca4d0680aa4490401f2a6b4544138","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":176,"label":"UI text/font","hash":"e8218b1c0f687ef67b71d7f9ed465a8d5fa29774f46c4d60992634e41e180d70","result":"bc46aa3a8ea65eb968f2204e1c6e082037b586abef0058d69074a789ccbd45f4","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"0c9dedbd7cde7e4dd277f207888387abab9c6e0d8a9c64580dc614557915fdb6","result":"2196038b77ee3e4a7508f240dc49c3ea143ad746c57a39c73e7671e69a0743c4","splices":[{"at":144,"remove":28,"bytes":"EQAAAOiHtOWRveS4gOWHu1vlpKddAAAA"}]},{"size":164,"label":"UI text/font","hash":"72a966bbcc138bfd897bf26ba439cd88a2cfc201d66f0cf7f9df78668fc8bb27","result":"c5e948cb97a3f09ac7ef29a1e2b82fa116566a78b3900237e7bc9b79dd5c40fd","splices":[{"at":144,"remove":20,"bytes":"DAAAAOaKgOiDveino+mUgQ=="}]},{"size":168,"label":"UI text/font","hash":"351cbd636b58a932d30be29512c62149f0573e7fa9a521bff19f9f12f9514853","result":"73ed49aec06bd5f935a2c1be07662f67215f3e631076ad3c3c849a4dd8763672","splices":[{"at":144,"remove":16,"bytes":"BgAAAOiThOWKmwAA"}]},{"size":176,"label":"UI text/font","hash":"72d1a02f5e17ae01a831d7c27741423d81f6d203930432a52a676e105c123b6f","result":"98597f10399376f99905196da6fd1f696372a20c896b5714b874e85700c199ce","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"cb22e18623e91c041edd157c88e39cedfc987f5e0e1292c7e27c37f4af09c76e","result":"9236ab533c825710965a58541fc2ee4fa0bd50e4168a1c84682113e609d479a5","splices":[{"at":144,"remove":23,"bytes":"DwAAAOaKgOiDveeGn+e7g+W6pg=="}]},{"size":164,"label":"UI text/font","hash":"2103b845ed3a753b03cf5af1ac9dd1875b28d245c1ae6cda2330bd99bbd4b85c","result":"a9853066bca0c5918c4c78dd3d1ff9e2eee042f383b3c2b4804f42c20df5e650","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"b2fbf32586596149552e4a74a938b80ca1cbb33c1e880a815c6e89f404ba624e","result":"181ceade88817801fb0b3d33957dd7eecb77c1132802b2de091f35675af49061","splices":[{"at":144,"remove":28,"bytes":"DAAAAOinkuiJsuWQjeensA=="}]},{"size":160,"label":"UI text/font","hash":"0b1a05e1022541f19d74e0acb60fd0e932705f2b9540db5243af9ff20570f3f9","result":"b6bc023a273d37e82573d4dbf2826121cd0b37550fd70eb92b6a06201f6d962d","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"12e35da7e01f79a87611c47d375b6fe3bc4ae683e4c03a711c072b462d93fb56","result":"797abbdd96d7c64ba9492ee71d11d4ce230c09c870c026c8aa7724da2dde916c","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":204,"label":"UI text/font","hash":"7aba2f83301fdf80720373926aced9dd2332a8b2924f7a2c16d3ec547c3b1675","result":"e7696d6a9a3b989fa54b36deed7701bf32dce8375d44f5a3ed6b4b43bbfc6248","splices":[{"at":144,"remove":52,"bytes":"LQAAAOWvueWNleS4quaVjOS6uumAoOaIkOaWqeWxnuaAp+eJqeeQhuaUu+WHu+OAggAAAA=="}]},{"size":188,"label":"UI text/font","hash":"e6db5c74889d1e966e042ac315af5503e1f9cac2731a37c75e2c6de0352b5432","result":"48677531e21e4b040168e55a513f2a8041470293b7a4710a194377ce0e9268cf","splices":[{"at":144,"remove":36,"bytes":"EQAAAOaBouWkjTI254K55L2T5YqbAAAA"}]},{"size":168,"label":"UI text/font","hash":"ddfa9330bb6a59990d4ae9a299ef8dea352287ebaa00ac0e997b8df525c30d0c","result":"1e11dcc2d8b28c6ae8d28b0466347dabb3452875a6d5d92b4bd4f7f0cd4fde33","splices":[{"at":148,"remove":12,"bytes":"5oqA6IO95ZCN56ew"}]},{"size":160,"label":"UI text/font","hash":"8391c4bde18a12ff2fb4fe78665b592e00a0af2eb4ee301f501bd6e7849c70e4","result":"8c3d1d998d29647def4a69a8eca3f35c2b836acb98862dfd180738ca45df7432","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":192,"label":"UI text/font","hash":"0b563e90533377d74de32a0d3ebc6918f694fe1fd85c027ab0f5939946559ecc","result":"edc6e6b6f24395acd85777c4991d726df88fbc87feba3101247a250e3d3136cf","splices":[{"at":144,"remove":48,"bytes":"GAAAAOivt+i+k+WFpeaCqOeahOeUqOaIt+WQjQ=="}]},{"size":164,"label":"UI text/font","hash":"e546b8a79a26441c3c0218aa6e1629be779ba786bdb8f207b336696168db43b2","result":"d8a4191e0f32cb278e46e6af02aa05785e0b084a1aa9ab7ff0a06babd7c77c75","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"27bb66af9d99aa2cd40237a9a889b26ef3f4e2d837a298102c1584e2eb294daa","result":"011cf796650b6c71ee66466479d986b189a0df19841efa00641d59344fe01205","splices":[{"at":144,"remove":26,"bytes":"EgAAAOaKveWNoeazqOaEj+S6i+mhuQ=="}]},{"size":164,"label":"UI text/font","hash":"164e40a3426fb8fe576b9592c4586c029519d4aa9d65bc5db83577bdc64056c5","result":"d48711e9b295ec610e7d3aaa29a19c37bfc87788edab515c26a4cbb79c85c180","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":184,"label":"UI text/font","hash":"8455790983e8dd8238bc0d36d7c3f3b0bb1ac0b66715d89834ad4b155c27dc37","result":"4d55bcacbbb4a737f89f58de1b51e5fe5b3c18890ad91ab95e6aa42c4322f2f7","splices":[{"at":144,"remove":31,"bytes":"DwAAAOWPr+afpeeci+WJp+aDhQ=="}]},{"size":156,"label":"UI text/font","hash":"e5557ee2e0a9e8f280c76e50953e60675bebb6e381ba18af1ef2fccdc4cd8dbc","result":"38453fb59fd7f5a729b83e4453c670ab209a51224da6044d6a9664798f5fb85b","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":172,"label":"UI text/font","hash":"fc430d4b8656aa09f7987010d40f94f0a33be3ef1d828b8bd875b2d42c1a1b0f","result":"05334a91c8c761302d6e1240276e8ccb3b879a7a651dee05048d654299c5583c","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"aa47e7d7d35f6964b24bd9bdfa82735897ccab0ee22621ee0eb2719f04ee8715","result":"9d7a8b2af81b423b486a97f7f0eff0cf7bfceb8aa54bc5ce85f8d5ce45e452b3","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"bd13f32d212c85efb0040a7a266d76c25e96019a3d1f45586281316e35ad46b4","result":"f65c62e57d992c9b726534e11d70e85ac3d4fd0f6834d57df4a3ed101d505915","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"00e8adc638973e41b2a7a7828e194ae8c53012c511775b41b926dff578c97dbf","result":"19af6811dd29241f74de612c5774a03f95d65204555c7470fc5336e91dc4c07d","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"cbef95918bad1cd99f0f64bf2ff7ed7009d02a299dd04634d8da2a93eccad1e1","result":"c23453cec5737e13d9eccaddd0bbc473e03f2823849226f71d02ea09bc630fa2","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWxnuaApwA="}]},{"size":180,"label":"UI text/font","hash":"b82f82ea7656e933f674ba2e23eb8fe5675bb43e2f694eb27105ea28ac762f46","result":"5406a206779a836e79a785d7c68af7b750e9a9eeda03a890be8d5f71177e81f1","splices":[{"at":144,"remove":26,"bytes":"EgAAAOOAkOaImOWcuuaWsOS6uuOAkQ=="}]},{"size":164,"label":"UI text/font","hash":"e748b25ac71515f0a4c41f8c2af06a783d4c245b39253a2fbf2c0aa1b020ce02","result":"98efc5f321cb5dc03077a6e3eeaa125062b90117ac61bb5eb5ed6b891ae9da96","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"69c5d9171fccb62a19f7aee1ab0dc6f555057656bd9ab321bf0ecc2c9cb005b0","result":"fde070f588d71c0cfd3844127ea0b2ca1f51d9031282ef6ce48dd02f674a0c97","splices":[{"at":92,"remove":66,"bytes":"thhU33YkmC8oAAAAAAAAAAAAAAAKAAAAKAAAAAQAAAAAAAAAAQAAAAEAAAABAAAAAACAPwYAAADlhbPpl60="}]},{"size":184,"label":"UI text/font","hash":"a595b379102ef9dda398797b2b54be471ff98d49fca3d407883746e42f1702ef","result":"74e47cd39cb614f853b00a700da138eb878ca7d9e93424c6f2ff02c87782f9db","splices":[{"at":92,"remove":83,"bytes":"thhU33YkmC8kAAAAAAAAAAAAAAAKAAAAKAAAAAQAAAAAAAAAAQAAAAEAAAABAAAAAACAPw8AAADlubjov5DmmJ/or6bmg4U="}]},{"size":168,"label":"UI text/font","hash":"679a7125a481aa48654cfee191675aa0a360735401ceb0e5e67527de3942efad","result":"4b10aa0fcda4598ab3e305972b046a1efc411cd1609b49d3c6dff0918f657845","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"36c4a5083caf463b351bc861617d71ccf198637e86d5f4e0371a0dcaee17da45","result":"28931e544fa0f7b07b03908af5f0b5ca5b1ca291b419553dbe8ad2500efb737f","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"494c7c635a9c8bbd4ae9ea02c646a436bfb871a611ecaf6339f5ba26bdb29dfe","result":"2af28be51f85c0c5538bfde15bc00dd5f12ac714cf51869f719084c143f975b2","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWxnuaApwA="}]},{"size":160,"label":"UI text/font","hash":"a7037fcedb1a9d08ace2e84ff4eae6d8092ad4206b7175768a7b6f437a75f489","result":"e9de8d00053bfe274bdbf13262f0c6f0f08f61e9ff821fab480a202e28bee426","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":252,"label":"UI text/font","hash":"2b0b2fdbef2d119f017326fe30d4ca4b0028b735cd1e0354a74587a66912243d","result":"9b7c57951b7fe6705edbac7f39709abd2aebccda44e27bdee72082f5918ac405","splices":[{"at":144,"remove":98,"bytes":"VQAAAOWwj+W5heaPkOWNh+aIkeaWueWFqOS9k+eahOeJqeeQhuaUu+WHu+WKm++8jOW5tuWkp+W5heaPkOWNh+mAn+W6pu+8jOaMgee7rTLlm57lkIjjgIIA"}]},{"size":168,"label":"UI text/font","hash":"b38853449f47d17adb342fd38333c969c2241c4d5eade34f71cd851da01745e5","result":"862eded14c5c518ac127c93c1b92e98ec4aa0467b65e167725cc6c7daed5f981","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"543172a79946299ae2c7c91bf095a33721cb719ee63bf0b59b4ffce77a66bc37","result":"4ab8acceaf40173cf4b34868ac309f625565425bcbe7e652d3baef3caa78047d","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"c152ebdcc0f2e00157e0a5d55062e3510db38b73148c9c1acfd4c7f71b017452","result":"9afc69f45f386eaae479ef641156cb2719b5440309419ad8861a0c5c53393141","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":172,"label":"UI text/font","hash":"7892efaaa60b76e343cc0824c03706e9510c6b5db36d0f7822958dd41a196d65","result":"781f907a7d8bfb8de87945dca028fd01a4e548a25d88a0d28ac19735d9c7892a","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"8aedde8ddae95011f1de81849394af69dcb6f70e36f63f1e0ace8f9019d1f173","result":"034bbd3ce9225415087091f5b370af48cd107153be08fbdc8f3284e4e7ab7cd7","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":204,"label":"UI text/font","hash":"e47bdcfe375a67478b1539861df3c6c177b17546b295ab155f51b469d95c5b2d","result":"cf4c044e909a3270ed6ec73f031e244b09885ea2dc116903911e155baec24b0b","splices":[{"at":144,"remove":52,"bytes":"GwAAAOebruWJjeayoeacieWcqOWUruWVhuWTgeOAggA="}]},{"size":188,"label":"UI text/font","hash":"dc221aa90969e51756f9934b77714bdd62b3e96c6488166735b11d1eaec5f6a7","result":"efada40ae3b99746fe53ac34efbcdcce1a3d8b61dced37731fc1a3950a7fdb41","splices":[{"at":144,"remove":34,"bytes":"GQAAAOW9k+WJjeS9k+WKmy/mnIDlpKfkvZPlipsA"}]},{"size":168,"label":"UI text/font","hash":"9003205af330c33e3ce9121159166444f43df4436093dd48fabd0998ec05aff7","result":"b3ce5d6cf1730280d2e0e5df406a183b8836c3176d5f1c3132460b1c21806fec","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"36e9507886b816ea1148345fbfec70501cc5051ff3f0d0fb576b0a1f9f4507e7","result":"073785850387c63f8ea9f2c381dae6abbb740758fc98e4191b086dbdef76a97c","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":188,"label":"UI text/font","hash":"c5bbc5ad34d01bd9a9404b64a5cdeb1869cb2d8dbfb61b7333ae5d8bd3f83ba2","result":"bd73cbfad5607c792c6898d59eeb84bb9bc659af73833efc27edda4a7ebec7c2","splices":[{"at":144,"remove":34,"bytes":"EgAAAOS4u+e6v+WJp+aDheWFs+WNoQ=="}]},{"size":164,"label":"UI text/font","hash":"468e8fd97be67ce531d6e1ac4d93322ac6d05c28c74e9c98a3484af8acc64bff","result":"c87fa2f2bf4d99167ea353d54af3c405cdf3e01c20d31ca63526e318b23e3cb1","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWxnuaApwA="}]},{"size":184,"label":"UI text/font","hash":"fe1f6dc3a9a1421a0f9c0b1ab570713c36d1b319a8a14d56a300e0694f150b5f","result":"5039c51e160b85288117a412476cf6dc6abf0cea76ee53408756b2856b8c721c","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"fd0993c87bc4f307ecb369162a547c30bbe198e3733b012c953a707c2066db99","result":"fa80b03d29a7a260a439347411492ec1b9fd68975d1f657cde0847d7e7691d11","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWxnuaApwA="}]},{"size":168,"label":"UI text/font","hash":"b26549fb6e0a9ef86e02363a5a92387fdf11bfb0a3a654573ba103fe38c0a220","result":"37d552560fb4c2505a4305222d65d9e87efb0b40d4ad470d72eecb5668f226d8","splices":[{"at":144,"remove":14,"bytes":"BgAAAOaOkuW6jw=="}]},{"size":172,"label":"UI text/font","hash":"4d40eaf4c3b861f84aded2d5922c6bf31c7468865e6bc2355adf21d94669abb5","result":"3ce2451faa30fa712f0fe12f84133861d93b1c927a2586573e397e40d4fdfad1","splices":[{"at":144,"remove":20,"bytes":"DAAAAOW9k+WJjeeKtuaAgQ=="}]},{"size":244,"label":"UI text/font","hash":"030f2c31eb225fdc9a42cf27c0977ee948ea3a2c0ea85fc8d1f5354ff641a219","result":"94ec53261aa6d2fbe8d261844c022cd19dfa50af6962dcacad31df99d0ec8c4d","splices":[{"at":92,"remove":144,"bytes":"thhU33YkmC8jAAAAAAAAAAAAAAACAAAA/gAAAAQAAAAAAAAAAQAAAAAAAAAAAAAAAACAPy4AAADkuIvmrKHliLfmlrDnibnljZbllYblk4EK6ZyA6KaBNDAw5Liq5bm46L+Q5pifAAA="}]},{"size":180,"label":"UI text/font","hash":"0b1f4b30fcb3ee51846ee264a18a5bc2914a63b2a17177d65c55ee2c0f5404b7","result":"e457c09bb43da0ee67af71074bba96ac3f9e0ffd11e125e2155cab24cbfea9d5","splices":[{"at":144,"remove":28,"bytes":"DAAAAOa0u+WKqOWFs+WNoQ=="}]},{"size":192,"label":"UI text/font","hash":"e38eb02e62cb7a85e0403004b1c30f6cb5d98c48ab47c74f9f5c410ef3459975","result":"803b7cb7eb76fddffeac7fe065aac7bf3193c74e85b3456c5a4f58e91aa80420","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"72f34bed11909f8bd7d16d6d7decf00e3cf9331b5b4c9e4445e39714854792c6","result":"94501d19504c35195f931ea7d26176b6786d7f564a97a11937235fa6565c9856","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"18a8196577567a2d7739137bbafee098d439303d7feb44e7f120bc176595232a","result":"5064e5766d7617646be9fee07d66226a2b668f629f4d5ef9dbacd1148188f5b5","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":260,"label":"UI text/font","hash":"189dcc5eb141419cd046ede7af054377883f7b68932150ebfe8834960568b8a1","result":"5f1e80ce3d5ef9267bf487c3551a0c8f6f4168d62c918a88b4351ae7c81ab536","splices":[{"at":144,"remove":105,"bytes":"RAAAAOe7iOS6juadpeWIsOi/memHjOS6hu+8gQrmnaXlkKfvvIzljrvjgIzphZLppobjgI0K6L+O5o6l5LyZ5Ly05ZCn"}]},{"size":180,"label":"UI text/font","hash":"d056884ede41762b262e181dd9acfdfbfd31f5e51ae0b45e702003696947e655","result":"b0f68d38d71d178bafba9c20e197d1ab597e6f002c8b86f2181a7ee87d7ec064","splices":[{"at":144,"remove":28,"bytes":"DAAAAOWJp+aDheS7i+e7jQ=="}]},{"size":164,"label":"UI text/font","hash":"c27605cac78b42543275dacdd7fb32c6d7986276bf37dd8b487e443472615241","result":"e21deb3e9d4bbfed29ff4f41163305222cce801caba8be06cbcffa8bff22d9e2","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":184,"label":"UI text/font","hash":"745689ff68a4a4cb6867a234077f5e96fc8fa278ac67f2ec86af34e05e725003","result":"3b271a26db352cf530cd994c2fb15e3f4f0091c6cf00cf479b9212690291348d","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"b4f723fb6aea81e1652ed27835803deb95f811d506c3b91044635ee1b2c87d97","result":"649e8f55a6f8903d769bf30cbd86268b4d0c2d5fae3005ff4f39afb8fa64478c","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"48b6284a83d3f45fd6ad7d2e3f433d0ae9ad4ef0ce937cdfd0c3e209fbaa8f11","result":"857f5ebd7bad5e7ae558bfbd0eea6ea6a47ff5b7e4a6e669195800a73768d5b5","splices":[{"at":144,"remove":15,"bytes":"BwAAADLlm57lkIg="}]},{"size":216,"label":"UI text/font","hash":"dd5ca6f5ea7e061ebd64fe36361a4f84fe888776e5a326c44ebc8728dc6ff639","result":"5eae1e958180e3700f59cf457d1c27ab2e353ec8dd99554b0716b5ad2a8e9e9b","splices":[{"at":144,"remove":64,"bytes":"HgAAAOaBreivt+elnuaYju+8jOaBtueBtemAgOaVo++8gQAA"}]},{"size":168,"label":"UI text/font","hash":"b47af5a15a9fc7c53c19a4e320d65a38cd0af94f1a0132458f937a5b10fe9dfd","result":"40fb8022bb4c8ddcecfd40c170ae6f599bed1eea9b64897d0d236090042dcae3","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":152,"label":"UI text/font","hash":"d6d06c33769fb41b9a402def701d0b5fdb0655f0e5524c7655719523d0833b79","result":"658866e7e78a2deaf897f7f701270f30ba53cb72496a985886c69c9ec19893b8","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"6fb4708877cb33571ec9875cb72d45874900379235b0d230711fbf49348f7d39","result":"5d8fcd98620ae9c06687ac3415bdac6d64cd403fc1f4ec85247fff2c3f887287","splices":[{"at":144,"remove":26,"bytes":"EgAAAOOAkOaImOWcuuaWsOS6uuOAkQ=="}]},{"size":188,"label":"UI text/font","hash":"151aa21f41aeb4e926903b997beb3ab419303897b50c4fbd3bdec884d2446af8","result":"2d58466e7afc18bf9a657ec6e06eb49f6d37fa00c575ba7a2f12d5f9461de7b9","splices":[{"at":92,"remove":88,"bytes":"thhU33YkmC8iAAAAAAAAAAEAAAAKAAAAKAAAAAQAAAAAAAAAAQAAAAAAAAAAAAAAAACAPwwAAADpmpDnp4HmlL/nrZY="}]},{"size":156,"label":"UI text/font","hash":"9219d96682a50d4fe8b63588bb2501476d66307abdf00145ec9ee88d6ced75ac","result":"a93b7b2caf0f50669b6d5fe4ddf63ea240e1f4e3d6046993dbb00523b35b569b","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"fa0af3b4e6c134d95f69f63882fe6597113524bf9ef9c57188b7db85b51991ab","result":"27e8377d6e3e52d36e4c607c7b6753f7ed5511e62421b8f1841197710a3bec6f","splices":[{"at":92,"remove":66,"bytes":"thhU33YkmC8kAAAAAAAAAAAAAAAKAAAAKwAAAAQAAAAAAAAAAQAAAAEAAAAAAAAAAACAPwYAAADlhbPpl60="}]},{"size":160,"label":"UI text/font","hash":"bc0d40dd0f5f4e4cfebe9fff0c4b4adf7431e8cb5166193c7eb891731e590a5e","result":"1495f3c7451222f13b8938c1e371bd0b5cd88a3e2719c7f70d2d0bb965dbdf88","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":204,"label":"UI text/font","hash":"f6a467ea99db26b2d986347f33df49548f5e7f7f7900747de01f3ef42adcdcf5","result":"643992467a7f61aaf9aeb457b6666ee5cbbfaa55366eeecda65da83a148984a8","splices":[{"at":144,"remove":52,"bytes":"LQAAAOWvueWNleS4quaVjOS6uumAoOaIkOaWqeWxnuaAp+eJqeeQhuaUu+WHu+OAggAAAA=="}]},{"size":164,"label":"UI text/font","hash":"4381cbfb29f7eda2addb92af814b8608cd1bf88afff4c13442e1f34d9def3eff","result":"fc1cfe83a08b3a50f1b6ad7f6b12e82b8aec18f3315a9040c9a430f66fe30be6","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"ddea2647ac31b01b1cb79249440e636d97c2ba73e88d5340949561e21599c2e0","result":"34cfa552354b90707c05868c79e11551bdd25cbead997c842ce0ce9230dcc463","splices":[{"at":92,"remove":66,"bytes":"thhU33YkmC8iAAAAAAAAAAAAAAAKAAAAKAAAAAQAAAAAAAAAAQAAAAAAAAAAAAAAAACAPwYAAADlhbPpl60="}]},{"size":160,"label":"UI text/font","hash":"9dfcb2d8b483265bf978db6119dccf79ef10e6fd9a2f472f4f19c50fb42a9b05","result":"f2a60139345bf76b1806b69c8e3707c98b5a9c19ed41342029533a002ae37a3c","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":188,"label":"UI text/font","hash":"1f37b86849eae147f6b592c92c33dc7c0463e1e6f406b898789190e568cbc0ba","result":"2a6d41a12354d14734b6024610cbc6d842b103d32251dfee7cc03aeb6044f655","splices":[{"at":92,"remove":86,"bytes":"thhU33YkmC8kAAAAAAAAAAAAAAADAAAAKQAAAAQAAAAAAAAAAQAAAAAAAAAAAAAAAACAPxIAAADmiJHmmK/mtYvor5XmtYvor5U="}]},{"size":164,"label":"UI text/font","hash":"490b922de14cae0e44ab4134ebd373a4efcf95899278758dfafc6aadaeae337c","result":"40b5df98684687b40dbf80412b7e60103dce27b077c968df74f2e9197aa9f378","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWxnuaApwA="}]},{"size":172,"label":"UI text/font","hash":"4d651ef68153845620d5db714571d6a081dbb649354a43de49e5558e728dec9f","result":"9ca121f235fdfda9d448c87889c9fa478f273e78d0c832cf36a3bfd319e07aee","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWPlua2iAA="}]},{"size":164,"label":"UI text/font","hash":"d7c5124605d10cce7ca446b141232be82883f6b191346fc220fe7471cd2fe78b","result":"cd73beef538e59f3e89d032addb1df0aaf98471d2305732ec5b3bc2def0e9573","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWxnuaApwA="}]},{"size":184,"label":"UI text/font","hash":"36b73bd3a22c659e5a591ea48d0f4d6a428790ac778c8ac5363d7aacd4604f2b","result":"fa2efe9d97c7864d417f225d1eb19776138ee6b37e25744d2f19705f2e4a64db","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":176,"label":"UI text/font","hash":"584420e9693e29da32d3b29ceef5c4e27acfff129172316c3f518b028653ef28","result":"861c72a18f850605ecfa285a31548fce0d4c1eebf471fb0ee105cf8d1cb61a05","splices":[{"at":148,"remove":18,"bytes":"6YCa6L+H5oiY5paX6Kej6ZSB"}]},{"size":160,"label":"UI text/font","hash":"2e325524ae4a64b1db48b5f544c32073596cc39ada1773ebaf0a67e794eb7582","result":"596f16655f285f7d5420804d24398e8cdc96bcf2370bd894e6209430133fb4c6","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"0808077aacce61aeafaeaa623065c30d4253a4cc9a8d6b8559cd34dbd71d7309","result":"7bdaba2202cbd45c5525da1c92bb3b804d3fc771ae98e24462c8209c298725c3","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"5e90bf94c1231f8dec90af4e0de91e534c989897b9c3af9f361f7142f651cd00","result":"8edea0fd2b417600c2f2eb83dc7dd4a4270d5d33f58368af7ddece94f8f24802","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"43c3b1b2dcbd5d28dded87d99d702a326f2a326088ae2eb454cf124f596371f4","result":"a2eb2003de9c14e041f0d432f6ee515fff2c0a2937188b0fab39151a039a6702","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"72a31a6801b72e2fd01a632a05ace6b2379e658d820bf49842b87996dfc7254b","result":"a457c1fe00dff08f7f3fe389d96fabfe80a7c2ddc748f153bc821e0db7e96f3f","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":236,"label":"UI text/font","hash":"bc65632d518081823293adc327ab90d554f4919d7f66965e827941f2643afef8","result":"aeea9837656fc45aa13740cf7e15ae55810b4227e88e23b16ec25515d694fbc5","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"2f2709e5f781e1b2053a9599dc1ce2c35f65132b44d963f9182e8990ce509fe4","result":"89b5f1d04a00bca2f5c2de6a59312eb27f3c6924beebac8438e93ec488cf797c","splices":[{"at":144,"remove":19,"bytes":"BgAAAOWxnuaApwA="}]},{"size":160,"label":"UI text/font","hash":"500347695193b75c138f83307f63a802f3c63482eab6d978d47a0f7db7fd2925","result":"8fa9378bd06891025eb347354ca48c25e8377c8ee0fd6382752fa1a23a18d2de","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"2eebe134648180be2bc6b57256da33df1a981cd88c353049b3ed3802090ee6d8","result":"a5b46b8dc288bbbbfadff0a5493c4a2929ef1ffa5d38f3d1c7bccb40ec8bce7e","splices":[{"at":144,"remove":16,"bytes":"BgAAAOS9k+WKmwAA"}]},{"size":168,"label":"UI text/font","hash":"7033a0c19f47160288c3f7d8c29312b1cb73cb466ef22f1ea969b2d75a4d3313","result":"d56dac94cb3f709ab014f0db03a0ff4d5c53be0d7a63b2b6de6746f7145ff1c8","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":172,"label":"UI text/font","hash":"4701ef9ebd0d5efcfdb6a20f28cc5b17ff7bb1241133d5b9af5a7f911461e683","result":"75447e7f1046c4b19d90cc85d7709b3e512b0dc66ebfee4c76ba8c142fced429","splices":[{"at":144,"remove":20,"bytes":"DAAAAOW9k+WJjeeKtuaAgQ=="}]},{"size":188,"label":"UI text/font","hash":"afbf2c7ab4222e06aa17053bd9822b5e59139246cc827de2e21e58b678e9b29f","result":"40e4a912f4be45e4e8a13bee9046c2b1a032492f3f70ce37d6cf080679d5dbcc","splices":[{"at":92,"remove":86,"bytes":"thhU33YkmC9QAAAAAQAAAAEAAAAMAAAAUAAAAAQAAAAAAAAAAQAAAAAAAAAAAAAAAACAPxIAAADnjqnlrrbnrYnnuqfmj5DljYc="}]},{"size":748,"label":"UI text/font","hash":"edac9555e54bda16f048b79b88ddddf672af05330fc39f25d4c96ee44903e2c7","result":"537d21969cb4bb1ad33627bf305c9c88f9601a459bb02ab0f59b7e752cf4375e","splices":[{"at":144,"remove":596,"bytes":"egEAACI1LjXlkajlubTpmZDlrprmir3ljaHnrKwy5by544CM5LuO6Zu+5Lit6LWw5ZCR6Zu+5aSW44CN5q2j5Zyo5Li+6KGM44CCCuaWsOinkuiJsuWcqOa0u+WKqOacn+mXtOeahOWHuueOsOamgueOh+aPkOWNh+OAggrmlrDop5LoibLor6bmg4Xor7flnKjop5LoibLor6bmg4XpobXpnaLnoa7orqTjgIIK5pys5qyh5paw6KeS6Imy5Zyo5rS75Yqo57uT5p2f5ZCO5LiN5Lya5Yqg5YWl5bi46am75oq95Y2h44CCCuKAu+aWsOinkuiJsuS7iuWQjuWPr+iDveWcqOWFtuS7luaKveWNoea0u+WKqOS4reWGjeasoeeZu+WcuuOAggrmnKzmrKHmir3ljaHljIXlkKvnmoTop5LoibLkuIDop4jor7fmn6XnnIvmj5DkvpvmpoLnjofjgIIK44CQ54m55Yir5LyY5oOg5rS75Yqo44CRIgAA"}]},{"size":160,"label":"UI text/font","hash":"8155a3dda4c51f949ed44474511c83b28b6c045c3a0d3f84f6be369c74fcb7b6","result":"291f20991e0db797385dcfc34fb39aa4554178507f60d355b13c077507ff29b2","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":164,"label":"UI text/font","hash":"f31b861f4a0b244e3df733adfb7af10308f93a6bf640bb159a41058e800dca96","result":"243b6db379161ffddc3824c552ffcd479e3b08bfe0ff49d2b3a9a9600416a5d2","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"949937a850b737c38dc984568df0a101c3f3293fde2bd2d1db59fcfef0cb0a74","result":"af97f5874feb415f5f2c18054e5f52e428627ea84e6cee3fe9ab5755536f2481","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":172,"label":"UI text/font","hash":"82793e6c3777fe57c97220690b54ebdf5b97c6f4cc562250e477e11062adfffb","result":"ac809541d4b5827ec096cda616b53a40b2c35a63cd853d48d47fcce7fc79429c","splices":[{"at":144,"remove":19,"bytes":"CQAAAOaOkuihjOamnAAA"}]},{"size":164,"label":"UI text/font","hash":"ee91c7e5ece64f2df4624e28ad33af1eee70984aab5815fb730c0f4a6437bcf8","result":"df9d65fd40e49d7730dfad5671ecd72859976ac192b3e51c1338d911c054484b","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"cc8707dc7401445d71277cca881e0fdca53ab53d46654dfc6ccb3a1fde9cbb34","result":"c1395b97e46b416955263764b8473b777381a3f047f9f71b0260e9c666841cec","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"589cc04f2e43bdefe4a8714facc50ec34dea3bb4199dd7b53c15d90165615c2a","result":"57630756564c4c298a73fc345913fefb00e442d75ac16902dc8e4438c192f447","splices":[{"at":144,"remove":16,"bytes":"BgAAAOiThOWKmwAA"}]},{"size":160,"label":"UI text/font","hash":"6bf1c60b69fcd492a1dc32e3957e04c5f5e3634782abad2c62d12deedf7d4c8c","result":"3a7163de18dc1a31dc1f1d756749620b471374406b441ed225338185666ef06b","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":172,"label":"UI text/font","hash":"49a6643e5ce6e3f28d2af9c9fd746ae07f75ea0f4f59cee09a319a450da17b08","result":"b5d8f429b2116df63bba6e9dc001557485616ba3e9b015c209846487e7b8aad4","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"fd058dfcce353cf018a6cdaf0c2d82d899eec4293b94b3cf58d055cfde55e91f","result":"2c0a9367117ab64494ba0ddc2665c4d1d5ecab1eb0fb84f3010f54275cf47251","splices":[{"at":144,"remove":28,"bytes":"EgAAAOehruiupOaBouWkjeS9k+WKmwAA"}]},{"size":156,"label":"UI text/font","hash":"2faa3e40130993b3fc57e36df6a38582eaac478564502cc49880d656484f0d35","result":"263cfa2213f2b737e09ad5c42bbffbc6604608e80bfbf5429a5688fd84cdfbcf","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"42a1bd1ca9c87e4813ab8e08f207f1f91975d2072f3d3e2a68583dbc58378426","result":"1e62e3c912ed13a52628d783bddd51c3d2e25023134bb78ede6de29c5c5f731c","splices":[{"at":92,"remove":66,"bytes":"thhU33YkmC89AAAAAAAAAAAAAAAFAAAAPQAAAAQAAAAAAAAAAQAAAAEAAAAAAAAAAACAPwYAAADlhbPpl60="}]},{"size":172,"label":"UI text/font","hash":"35b161ba8ed26ded62e727db964605ea7cb418b21dcf26832d3f7dd92c2694b0","result":"4f1cd70ff9f51d5777ae9d643524e503e43262c423958552cbe704aaebcfa064","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":192,"label":"UI text/font","hash":"cc567152ead3485f2ef483c4c9a208fb998650e9061f65e2d77a0bf66d372feb","result":"a03063e681f63a515961f48fdb9e1a0827a7402c5e1905117c98a680f2789637","splices":[{"at":144,"remove":39,"bytes":"GwAAAOS9v+eUqDHkuKrmgaLlpI0zMOeCueS9k+WKmw=="}]},{"size":196,"label":"UI text/font","hash":"9c7fcebc9f1bb94bcf2a54da332fe0b46de5923f7f388a94e3a16a9280e33856","result":"cd78a4cc5abe8a21988874f8d18842b3bae7680e2b7bf6ba378aa3e3c76c4792","splices":[{"at":144,"remove":43,"bytes":"IQAAAOWFjei0uemDqOWIhuWwhummluWFiOiiq+a2iOiAl+OAggAA"}]},{"size":168,"label":"UI text/font","hash":"70e8ce102b8dbd96a04f3dc0615cd45f693b6e43e5674c71a1447941616e78ea","result":"d1834159811a65ebaa26aaeea43dfbd8e0bafebd2d5513bb932f2049b3a308ff","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"d14067d113698f586455a84e7ea485f9965baf6b392825fe8536f87e5227299a","result":"f963c60b0d75d8d2261d5e0f4f25baf30eed66ee95db74e64c04e6e25836545d","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"04ba037a2b002b8d8fc05daf9d81de1210f0f25b765f107c4d1e35aa224e2b31","result":"214be331b2781ba3a3d92d1c13cc9c066e76e837f519b1adc1ea83ff3e6b7567","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"b27bc366ab04d219f683615ca9e96cb6923490cb93fcdae81000861ca0db511e","result":"2f9e696f1e06b38c7b97504e8445a9c3d17ede504b0765e82dcbb8707b3ac7c6","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":168,"label":"UI text/font","hash":"9dde1517d9adef3bc98a6e2655bc23da48813500d718909f0b99cc5d042e83f5","result":"39940d5f6959f23f81da819cd9f3c992ebdd6bad77b565466009a09a319748cd","splices":[{"at":92,"remove":68,"bytes":"thhU33YkmC8oAAAAAAAAAAAAAAAKAAAAKAAAAAQAAAAAAAAAAQAAAAAAAAAAAAAAAACAPwYAAADoj5zljZUAAA=="}]},{"size":160,"label":"UI text/font","hash":"f0b89f2f638cbe7118207c90588caf23e7cf555baf63544540868b68c0982b02","result":"57b1db2d212c053873d23d2b5e0e08c06cf83b6821117a643268e6fc630e68aa","splices":[{"at":144,"remove":14,"bytes":"BgAAAOaOkuW6jw=="}]},{"size":172,"label":"UI text/font","hash":"168914c105233a90e93e4f44d9668db7e2d2f34fafe44ebeef7e848b40612193","result":"8718553a5d21e98fcea57330bffe6476e72b83cb72f75c85e0ef5bfbd7fc198f","splices":[{"at":144,"remove":20,"bytes":"DAAAAOW9k+WJjeeKtuaAgQ=="}]},{"size":204,"label":"UI text/font","hash":"02f95f317fa3682cb2058eaa719549b531cf29c53db369da8f684385659961f1","result":"a2575afe048a6c79b99fbcd879d173147fb4cdb7ad2868f2aaff22e929bf8aa1","splices":[{"at":144,"remove":52,"bytes":"LQAAAOWvueWNleS4quaVjOS6uumAoOaIkOaWqeWxnuaAp+eJqeeQhuaUu+WHu+OAggAAAA=="}]},{"size":168,"label":"UI text/font","hash":"55244994274b02fe563bc4cbc933fb21cb13881f4787825c202ca5abf54630e0","result":"223fbd76d4e78fb5efeba2052411350dbf95ab1fdaa9d3c6f8249040c850452a","splices":[{"at":144,"remove":16,"bytes":"BgAAAOS9k+WKmwAA"}]},{"size":160,"label":"UI text/font","hash":"4bca2c9de9c5a07443547b1736a0272587f2f995bd127da0c1abb0d53871dfd0","result":"710efad2ba81209d8a2b9449600de300fc9eeccc5967da18d1872e49c666a332","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"6ec97a389436855d81392732aa43761f7dcbff6b0f7e0bd48aafec7c43baf90b","result":"6bb9329cacdc34ff9987c2265547ccfd0a51bbccb90aa8e273465e2f65125dae","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":160,"label":"UI text/font","hash":"60897142e8d25d91556a16485234f13f51c4ded6d53e78ba3077cf9aa1eb20c6","result":"2b772f0698c0232562dacf2ebc2e005ebfb85d7b286ed244d16bcb962e837a92","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":216,"label":"UI text/font","hash":"7bd912f64101286000ea36ec5bfc40a599600be374d98a3814cac8149c1d495a","result":"662b753d12d94bb393fbb424196e9109fba5740c2f539ca81c1a1d385cc92a3e","splices":[{"at":144,"remove":64,"bytes":"JgAAAOWFs+S6juKAnEVjcmlidXPigJ3oo4XlpIfmlbDph4/vvIxTaXJpAAA="}]},{"size":1112,"label":"UI text/font","hash":"e5ebeec27ec94d795bbc7418fb72a13aa6bf2af4d4f0df4be30a8049de0cb4be","result":"9addbc4e1a68d113fa518254808f39133e5ca2b82bb6e3fe94ea4ac2d70aa938","splices":[{"at":144,"remove":959,"bytes":"WwIAACLmr4/mrKHmir3lj5blnYfmjInnhaflkITop5LoibLorr7lrprnmoTmj5DkvpvmpoLnjofov5vooYzjgIIKIOWkmuasoeaKveWPluaXtu+8jOS5n+S8muS+neaNruaPkOS+m+amgueOh+mAkOasoeaKveWPluOAggog55Sx5LqO572R57uc6YCa5L+h54q25Ya15oiW5YW25LuW5Y6f5Zug77yM5oq95Y2h5ryU5Ye65Y+v6IO96KKr6Lez6L+H77yMCiDmiJbml6Dms5XmraPluLjmmL7npLrvvIzkvYbop5LoibLlkozmir3ljaHku6PluIHku43kvJrmraPluLjojrflvpfjgIIKIOiBlOezu+WuouacjeWJje+8jOivt+WFiOafpeeci+ebuOW6lOeahOiOt+W+l+iusOW9leOAggog5ZCM5LiA5Z+656GA6KeS6Imy55qE5LiN5ZCM5b2i5oCB5peg5rOV5ZCM5pe257yW5YWl6Zif5LyN77yM5pWs6K+35rOo5oSP44CCCiDmir3ljaHlj6/og73ph43lpI3ojrflvpfnm7jlkIzop5LoibLjgIIKIOmHjeWkjeiOt+W+l+W3suaLpeacieeahOinkuiJsuaXtu+8jOS8muiHquWKqOi9rOaNouS4uuWvueW6lOinkuiJsueahOeijueJh+OAgQog6KeS6Imy57uP6aqM5b6956ug562J6YGT5YW344CCCiDmr4/ml6XkuIDmrKHnmoTmipjmiaPmir3ljaHkuo7mr4/lpKk1OjAw6YeN572u44CCIg=="}]},{"size":176,"label":"UI text/font","hash":"5535582b61a2f4aad6fda46805cd736aa8b7f77ff82aa6c767555913139df9da","result":"e8cd18647dbe33286d82e52d67cefe41faf5120043e3da9cce095df8b1f2565d","splices":[{"at":144,"remove":22,"bytes":"CQAAAOefs+WktOS6ugA="}]},{"size":168,"label":"UI text/font","hash":"ca2a8fb603349e7d6ecad89e704c11ac715c34f11f9422a2fe81651963e47709","result":"ee9beffa56e2c0cab1ab85e1f1d2ac29fae3468af2e8db0d8c023bf3217a582e","splices":[{"at":144,"remove":14,"bytes":"BgAAAOWFs+mXrQ=="}]},{"size":176,"label":"UI text/font","hash":"4263a2c70383ce4167f7ff1b66b11dd94f669f5beb2a69a8426d2da946267e30","result":"12ca27f921fadeda689685447752feb1e06f33d8a19b42be69a744a971ba4359","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":156,"label":"UI text/font","hash":"da6f9b7b1a52dcd18202bd31c618ac9270146f0b240864d82385234da2acfffc","result":"3584db1805024831e677caf1ab629e1e9417084db22f27b98951532a06f41bad","splices":[{"at":92,"remove":8,"bytes":"thhU33YkmC8="}]},{"size":180,"label":"UI text/font","hash":"677399c78e29662fcdd1440acec33daa9c87b1f2403d7c0b6bf0d7bfd0ef86d7","result":"7942685ca643962b34e5f058ef2bb9a76efa62794da47cd5f67ba401aad05031","splices":[{"at":144,"remove":26,"bytes":"EgAAAOaKveWNoeazqOaEj+S6i+mhuQ=="}]},{"size":180,"label":"UI text/font","hash":"0ada7b195a1d8a4b47c8ae7951bef23ccba511d29d23d6f50110da09db56d2ab","result":"69a408dad59aea60e53d2c51c2920d3a57b729a1430b0e5ec4c0fc1ab37214cd","splices":[{"at":144,"remove":28,"bytes":"EgAAAOehruiupOaBouWkjeS9k+WKmwAA"}]},{"size":168,"label":"UI text/font","hash":"cea523e734e408a91bee3b60a44f25070bd54feee4f62244d1ebfa2cf1ad3d28","result":"739a2b7e884a7f5ea5241afac3619537c03cf355fe7032b250af87aadb5f3059","splices":[{"at":148,"remove":12,"bytes":"5Z+D5q+U5aWl5pav"}]},{"size":196,"label":"UI text/font","hash":"7ea6da8637e6a3492f4219e061f4c8a5ec800ce84535be5734abb04b469dd903","result":"85b15a592c7dbb236f3d8c9f0ef7688e15cac8b1b865b47e2530f07f78d2b0d3","splices":[{"at":144,"remove":43,"bytes":"IQAAAOKYhTLCt+Wfg+avlOWlpeaWr+eahOiusOW/hueijueJhwAA"}]},{"size":168,"label":"UI text/font","hash":"813dad301e05a2a6976246c7b1983c5720f59f0fa42b19027622a8f2e623dfd4","result":"966aa0e8e2a121a216292b5f1ad65d85505fa6c014bb5fe0dc4b1b8869ee7a67","splices":[{"at":144,"remove":16,"bytes":"CQAAAOacieacn+mZkAAAAA=="}]},{"size":168,"label":"UI text/font","hash":"d5c5bdb7b7cd2ce74c6abd697f64c04f2be145c66994a72c47e9320055e84ac6","result":"74a7dbaa06e0c2cf3e5d899931bcd44a3822dde7e8d5ef46bf754c1361529d4b","splices":[{"at":144,"remove":16,"bytes":"BgAAAOmihuWPlgAA"}]},{"size":168,"label":"UI text/font","hash":"0b8e4b2a9c6ed6748410b993ce07aa89ff1bde21b55d40fb510b9c6babaace35","result":"8a93409c89d3dfc5e5cc14a7d580f546a161ac7dea88d6681867f2bd2f7711d0","splices":[{"at":144,"remove":16,"bytes":"BgAAAOmihuWPlgAA"}]},{"size":188,"label":"UI text/font","hash":"1506e2c9ec4e4b5eb622bcfeceddbe353cdb92f40bc5fabe1e8a98e5ac9e0889","result":"68494421e99c8f56f0dc6c0bf47ecb7bb535e9ac8f6fb1f06017afae43beba04","splices":[{"at":144,"remove":35,"bytes":"DwAAAOaaguaXoOmCruS7tuOAgg=="}]},{"size":220,"label":"UI text/font","hash":"18329997cdd453afa23987f64d9fe564fa13c08cfb2c5d66cc4e72af34ea8f34","result":"725636d6d18cfa5fdbb7c5e2e0cbef8983d4f95c9effd0ebaa0b49cd425fb465","splices":[{"at":144,"remove":66,"bytes":"NQAAAOS7u+WKoeabtOaWsOi/mOWJqSBY5aSpWOWwj+aXtiAgICAgICAgICAgICAgICAgICAgMC82AA=="}]}];
const resourcePlans={"uiprefab":[{"nodes":{"CAB-1fa5896057724a048340e98a165f98fe":[[967152,0],[982248,1],[982504,2],[993168,3],[1012704,4],[1014672,5],[1014840,6],[1016280,7],[1083912,8],[1097408,9],[1102480,10],[1110864,11],[1140568,12],[1147200,13],[1202032,14],[1229920,15],[1237720,16],[1249616,17],[1293672,18],[1309360,19],[1312344,20],[1320128,21],[1343736,22],[1349616,23],[1355400,24],[1362248,25],[1364096,26],[1402880,27],[1409192,28],[1421056,29],[1441840,30],[1458616,31],[1459616,32],[1463608,33],[1466928,34],[1503880,35],[1514200,36],[1514368,37],[1557952,38],[1563808,39],[1565712,40],[1574096,41],[1583400,42],[1619576,43],[1660400,44],[1690288,45],[1703408,46],[1709176,47],[1729464,48],[1750104,49],[1766344,50],[1772112,51],[1778440,52],[1781952,53],[1794240,54],[1803008,55],[1817744,56],[1822608,57],[1875600,58],[1885360,59],[1894048,60],[1895776,61],[1914584,62],[1946704,63],[2014368,64],[2018760,65],[2052800,66],[2055584,67],[2075464,68],[2078480,69],[2117584,70],[2119592,71],[2124960,72],[2149768,73],[2151584,74],[2155464,75],[2236416,76],[2267496,77],[2312168,78],[2350656,79],[2360240,80],[2373256,81],[2381320,82],[2389888,83],[2391056,84],[2409240,85],[2430408,86],[2460752,87],[2481616,88],[2509792,89],[2520648,90],[2524376,91],[2527848,92],[2561960,93],[2573544,94],[2591904,95],[3058728,96],[3066384,97],[3071728,98],[3079360,99],[3081880,100],[3087104,101],[3091400,102],[3117728,103],[3126208,104],[3131136,105],[3131832,106],[3140520,107],[3180648,108],[3188424,109],[3195208,110],[3323176,111],[3340872,112],[3341872,113],[3368656,114],[3446128,115],[3454400,116],[3463480,117],[3478200,118],[3511016,119],[3521168,120],[3538432,121],[3563224,122],[3590200,123],[3602824,124],[3611776,125],[3633296,126],[3640712,127],[3642560,128],[3655536,129],[3684288,130],[3700208,131],[3705520,132],[3729800,133],[3788872,134],[3796296,135],[3833440,136],[3871512,137],[3897392,138],[3899448,139],[3901992,140],[3924808,141],[3928696,142],[3940984,143],[3945920,144],[3952424,145],[3969336,146],[3972264,147],[3988744,148],[4015448,149],[4022144,150],[4033672,151],[4054832,152],[4063008,153],[4069288,154],[4096016,155],[4127712,156],[4152616,157],[4167032,158],[4173664,159],[4179952,160],[4181024,161],[4187440,162],[4190448,163],[4201640,164],[4207008,165],[4214600,166],[4226272,167],[4240928,168],[4259704,169],[4269992,170],[4274304,171],[4284752,172],[4306344,173],[4318576,174],[4362712,175],[4363392,176],[4367856,177],[4376144,178],[4392048,179],[4411568,180],[4427536,181],[4459248,182],[4538448,183],[4545960,184],[4566040,185],[4582488,186],[4586912,187],[4617432,188],[4627752,189]]},"source":"c4739be6833b6720761b26079624d8ebd75cc49873001adeb0f6e07913a13147","proof":{"category":"uiprefab","translatedTexts":85,"fontReferences":118},"result":"78b82c9984bdc9f75e5f228398d2fc3f3d1b0b65a3c02145d608a6be06411e94"},{"nodes":{"CAB-1fa5896057724a048340e98a165f98fe":[[967056,0],[982152,1],[982408,2],[993072,3],[1012608,4],[1014576,5],[1014744,6],[1016184,7],[1083816,8],[1097312,9],[1102384,10],[1110768,11],[1140472,12],[1147104,13],[1201936,14],[1229824,15],[1237624,16],[1249696,17],[1293752,18],[1312408,20],[1320192,21],[1343800,22],[1349680,23],[1362296,25],[1364144,26],[1409224,28],[1421088,29],[1441872,30],[1458648,31],[1459648,32],[1463640,33],[1466960,34],[1503912,35],[1514232,36],[1514400,37],[1557984,38],[1563840,39],[1565744,40],[1574128,41],[1583432,42],[1619608,43],[1660424,44],[1690312,45],[1703432,46],[1709200,47],[1729488,48],[1750128,49],[1766368,50],[1772136,51],[1778464,52],[1781976,53],[1794264,54],[1803032,55],[1822624,57],[1875616,58],[1885376,59],[1894064,60],[1895792,61],[1914600,62],[1946720,63],[2014384,64],[2018776,65],[2052816,66],[2055600,67],[2075480,68],[2078496,69],[2117600,70],[2124960,72],[2149768,73],[2151584,74],[2155464,75],[2236432,76],[2267512,77],[2312184,78],[2350704,79],[2360288,80],[2373304,81],[2389936,83],[2391104,84],[2409288,85],[2430456,86],[2460800,87],[2481664,88],[2509840,89],[2520696,90],[2524424,91],[2527896,92],[2562008,93],[2573600,94],[2591960,95],[3058696,96],[3066352,97],[3071696,98],[3079328,99],[3081848,100],[3087072,101],[3091368,102],[3117696,103],[3126176,104],[3131104,105],[3131800,106],[3140488,107],[3180624,108],[3188400,109],[3195184,110],[3323152,111],[3340848,112],[3341848,113],[3368632,114],[3386000,190],[3446104,115],[3454376,116],[3463456,117],[3470104,191],[3478184,118],[3521136,120],[3538400,121],[3563192,122],[3590168,123],[3602792,124],[3611744,125],[3633264,126],[3640680,127],[3642528,128],[3655504,129],[3684256,130],[3700176,131],[3705488,132],[3729768,133],[3788840,134],[3796264,135],[3833408,136],[3871480,137],[3897360,138],[3899416,139],[3901960,140],[3924784,141],[3928672,142],[3940960,143],[3945896,144],[3952400,145],[3969312,146],[3972240,147],[3988720,148],[4015424,149],[4022120,150],[4033648,151],[4054808,152],[4062984,153],[4069264,154],[4095992,155],[4127688,156],[4152592,157],[4167008,158],[4173640,159],[4179928,160],[4181000,161],[4187416,162],[4190424,163],[4201616,164],[4206984,165],[4214576,166],[4226248,167],[4240904,168],[4259680,169],[4269968,170],[4274280,171],[4284728,172],[4306320,173],[4318552,174],[4362688,175],[4363368,176],[4367832,177],[4376120,178],[4392024,179],[4411544,180],[4427512,181],[4459224,182],[4538424,183],[4545936,184],[4566016,185],[4582464,186],[4586888,187],[4617408,188],[4627728,189]]},"source":"baf4ca007fd8ee76e7a16c414d4f5b3ec4a2a4668b48bb6f0863fae56ffd029a","proof":{"category":"uiprefab","translatedTexts":80,"fontReferences":118,"entry":"G"},"result":"ae6bdfdafa28352e6020958d18ddcb5e1b910be8d68c3a6e0c993acc7be78d9a"},{"nodes":{"CAB-1fa5896057724a048340e98a165f98fe":[[989120,0],[1004264,1],[1004520,2],[1015856,3],[1036384,4],[1038368,5],[1038536,6],[1039976,7],[1109312,8],[1128448,10],[1136880,11],[1167584,12],[1174208,13],[1201024,192],[1230480,14],[1259112,15],[1266848,16],[1279336,17],[1324656,18],[1343896,20],[1352024,21],[1376408,22],[1382040,23],[1394744,25],[1396592,26],[1442672,28],[1454760,29],[1475856,30],[1493320,31],[1494320,32],[1498360,33],[1501680,34],[1539160,35],[1549480,36],[1549648,37],[1593920,38],[1600056,39],[1601672,40],[1610608,41],[1620616,42],[1629392,193],[1657600,43],[1699568,44],[1730064,45],[1743368,46],[1749304,47],[1770512,48],[1791768,49],[1808784,50],[1814968,51],[1821552,52],[1825360,53],[1837904,54],[1847608,55],[1867912,57],[1922632,58],[1932600,59],[1941816,60],[1943560,61],[1963352,62],[1996424,63],[2065080,64],[2069848,65],[2104728,66],[2107176,67],[2127504,68],[2130776,69],[2177936,72],[2203920,73],[2205736,74],[2209744,75],[2292704,76],[2324008,77],[2408784,79],[2418272,80],[2431328,81],[2448304,83],[2449632,84],[2467800,85],[2489760,86],[2520104,87],[2541240,88],[2570088,89],[2581296,90],[2584880,91],[2588944,92],[2623296,93],[2635696,94],[2654472,95],[3132656,96],[3140216,97],[3145904,98],[3146504,194],[3154320,99],[3157080,100],[3162280,101],[3166920,102],[3194696,103],[3203240,104],[3208184,105],[3208880,106],[3218432,107],[3258840,108],[3267272,109],[3274408,110],[3403960,111],[3421816,112],[3422816,113],[3423752,195],[3450744,114],[3530232,115],[3538336,116],[3547752,117],[3562184,118],[3599416,196],[3606008,120],[3623624,121],[3649496,122],[3677304,123],[3690408,124],[3699624,125],[3721784,126],[3729568,127],[3731536,128],[3744640,129],[3773312,130],[3789528,131],[3795080,132],[3819968,133],[3880472,134],[3887984,135],[3965096,137],[3991720,138],[3993840,139],[3996240,140],[4019464,141],[4023400,142],[4035408,143],[4040360,144],[4046992,145],[4063936,146],[4066880,147],[4084248,148],[4111488,149],[4118520,150],[4129920,151],[4151328,152],[4159624,153],[4166440,154],[4193696,155],[4226528,156],[4251528,157],[4266744,158],[4273360,159],[4280144,160],[4281216,161],[4287944,162],[4291136,163],[4302616,164],[4308184,165],[4315680,166],[4327368,167],[4341800,168],[4360952,169],[4371408,170],[4375736,171],[4386576,172],[4408896,173],[4421048,174],[4466664,175],[4467344,176],[4471976,177],[4480280,178],[4496704,179],[4517048,180],[4533888,181],[4565784,182],[4646560,183],[4654448,184],[4674936,185],[4692048,186],[4696424,187],[4727304,188],[4737904,189]]},"source":"a4ccd03fd2ca2d948f377c0ee5b35940acc957417fc74aebe99c8c8f0e937abe","proof":{"category":"uiprefab","objects":184,"additionalTexts":5,"entry":"AWS-current"},"result":"a9bbecad58ba28cc10261a0d1d5071022a2b591df76ef919d9fb3f9096cb314f"}],"font":{"nodes":{"CAB-30b7e125fae917e477ff14d3d68d8be2":[{"start":11216,"size":3132566,"label":"KingnamypeYuanmoSC-Regular","hash":"ecafefaf90c4013d940c7b62bcc304672d42af36d8ed02e5f4c736285a572eb0","result":"a0ee2d7c878f2c6e8be06fd035657268db55cde0e2a1ef99c77f724631da32aa","segments":[{"bytes":"GgAAAEtpbmduYW15cGVZdWFubW9TQy1SZWd1bGFyAAAAAIBBAAAAAEDLJTnMsJR7AACAQQAAAABrChsn+8XwjgAAAAAAAIA/AAAAAAEAAAD+////AAAAAAAAAADNzMw9qIRYAA=="},{"copy":[3145388,5801128]},{"bytes":"r0dhQZDC9b8AAAAAAQAAAAoAAABUaWVqaWxpIFNDAAAAAAAAAAAAAAAB"}]},{"start":8946688,"size":358562,"label":"DARUMADROPONE-REGULAR","hash":"98dc631a311946a28fd54f14a6950b9cb193271fb3972618a4d042926c7154d9","result":"6ff9e4aa59a8d839c4bb6418e2015dd858916004c536539d23e7d0ebd44dc462","segments":[{"bytes":"FQAAAERBUlVNQURST1BPTkUtUkVHVUxBUgAAAAAAgEEAAAAAfaTd7Cuip8YAAIBBAAAAAP4Ly9u1FG9PAAAAAAAAgD8AAAAAAQAAAP7///8AAAAAAAAAAM3MzD2ohFgA"},{"copy":[3145388,5801128]},{"bytes":"r0dhQZDC9b8AAAAAAQAAAAoAAABUaWVqaWxpIFNDAAAAAAAAAAAAAAAB"}]},{"start":9305512,"size":10107918,"label":"MaruJP","hash":"d43629394a008f100c5d7e29133746ded41e77c6c68b7462814a255a58451d04","result":"7f3f24c7827dd9fc22b4a6582ee470854678d55c4873ccfe0c3e66b81448cfd3","segments":[{"bytes":"BgAAAE1hcnVKUAAAAACAQQAAAACQn/XmSMzsdQAAgEEAAAAAx5OkALGSakMAAAAAAACAPwAAAAABAAAA/v///wAAAAAAAAAAzczMPaiEWAA="},{"copy":[3145388,5801128]},{"bytes":"r0dhQZDC9b8AAAAAAQAAAAoAAABUaWVqaWxpIFNDAAAAAAAAAAAAAAAB"}]}]},"source":"fe74a6b499abc47ce553f88f62b4b5a2c0d4db359beddc37c31ca3bde3c8430c","proof":{"category":"font","fonts":3},"result":"bc7bde9fb8a3601ff037b97e22a375af31f5c9d941f2ef45970811dac209060a"}};
for(const plan of resourcePlans.uiprefab)for(const [node,rows] of Object.entries(plan.nodes))plan.nodes[node]=rows.map(([start,i])=>({...uiPatchPool[i],start}));
const native={fetch:window.fetch?.bind(window),ab:Response.prototype.arrayBuffer,blob:Response.prototype.blob,clone:Response.prototype.clone,body:Object.getOwnPropertyDescriptor(Response.prototype,'body')};
const processed=new WeakSet(),jobs=new Map(),originalBodies=new WeakMap(),originalResponses=new WeakMap(),LIMIT=64*1024*1024;
const status={table:{state:'waiting'},font:{state:'waiting'},assembly:{state:'waiting'},uiprefab:{state:'waiting'},scene:{state:'waiting'},cache:{state:'waiting'},translation:{state:'waiting'}};
let updateStatus=()=>{};
Object.defineProperty(window,'__tsubakiChineseFontStatus',{value:Object.freeze({getStatus:()=>({...status}),refreshResourceCache,checkTranslationUpdate})});
const target=url=>{try{return /(?:^|[/])defaultpackage_assets_localresources_(?:table|font|uiprefab|assembly|scene)(?:[._-][a-zA-Z0-9_-]+)?[.]bundle$/i.test(new URL(String(url),location.href).pathname);}catch{return false;}};
const tableTarget=url=>{try{return /(?:^|[/])defaultpackage_assets_localresources_table(?:[._-][a-zA-Z0-9_-]+)?[.]bundle$/i.test(new URL(String(url),location.href).pathname);}catch{return false;}};
function cacheMatch(key,value,onlyTable=false){
  const urls=[key,key?.url,key?.request?.url,value?.url,value?.request?.url,value?.cacheKey];
  return urls.some(x=>typeof x==='string'&&(onlyTable?tableTarget(x):target(x)));
}
async function refreshResourceCache(onlyTable=false){
  let deleted=0;
  if(window.caches)for(const name of await window.caches.keys()){
    const cache=await window.caches.open(name);
    for(const request of await cache.keys())if((onlyTable?tableTarget(request.url):target(request.url))&&await cache.delete(request))deleted++;
  }
  if(window.indexedDB?.databases)for(const info of await window.indexedDB.databases()){
    if(!info.name)continue;
    const db=await new Promise((resolve,reject)=>{const request=window.indexedDB.open(info.name);
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error||Error('打开缓存失败'));
      request.onupgradeneeded=()=>{request.transaction.abort();reject(Error('缓存结构正在更新'));};});
    try{for(const name of Array.from(db.objectStoreNames)){
      deleted+=await new Promise((resolve,reject)=>{const tx=db.transaction(name,'readwrite'),store=tx.objectStore(name);
        let count=0,scanned=0;const request=store.openCursor();
        request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;
          if(++scanned>100000){tx.abort();return;}
          if(cacheMatch(cursor.key,cursor.value,onlyTable)){cursor.delete();count++;}cursor.continue();};
        request.onerror=()=>reject(request.error||Error('缓存扫描失败'));
        tx.oncomplete=()=>resolve(count);tx.onabort=()=>reject(tx.error||Error('缓存扫描中止'));
      });
    }}finally{db.close();}
  }
  return deleted;
}
const cacheReady=(async()=>{try{
  status.cache={state:'processing'};updateStatus();
  const marker='tsubaki-original-resource-migration-1.2';
  let migrated=false;try{migrated=localStorage.getItem(marker)==='done';}catch{}
  const deleted=migrated?0:await refreshResourceCache();
  if(!migrated)try{localStorage.setItem(marker,'done');}catch{}
  status.cache={state:'applied',deleted};updateStatus();
}catch(e){status.cache={state:'failed',error:String(e?.message||e).slice(0,300)};updateStatus();console.warn('[椿中文字体] 自动缓存检查失败',e);}})();
const nativeAppendChild=typeof Node!=='undefined'&&Node.prototype.appendChild;
if(nativeAppendChild)Node.prototype.appendChild=function(child){
  if(child instanceof HTMLScriptElement&&/(?:^|[/])CryWeb[^/]*[.]loader[.]js$/i.test(new URL(child.src,location.href).pathname)&&typeof child.onload==='function'&&!child.onload.__tsubakiCacheWait){
    const onload=child.onload;
    const delayed=function(...args){cacheReady.then(()=>Reflect.apply(onload,this,args));};
    Object.defineProperty(delayed,'__tsubakiCacheWait',{value:true});child.onload=delayed;
  }
  return Reflect.apply(nativeAppendChild,this,[child]);
};
function wrapUnityFactory(original){
  if(typeof original!=='function'||original.__tsubakiCacheWait)return original;
  const wrapped=function(...args){return cacheReady.then(()=>Reflect.apply(original,this,args));};
  Object.defineProperty(wrapped,'__tsubakiCacheWait',{value:true});return wrapped;
}
try{
  const descriptor=Object.getOwnPropertyDescriptor(window,'createUnityInstance');
  if(!descriptor||descriptor.configurable){let current=wrapUnityFactory(window.createUnityInstance);
    Object.defineProperty(window,'createUnityInstance',{configurable:true,enumerable:descriptor?.enumerable??true,get(){return current;},set(value){current=wrapUnityFactory(value);}});
  }else if(descriptor.writable)window.createUnityInstance=wrapUnityFactory(window.createUnityInstance);
}catch(e){console.warn('[椿中文字体] 未能等待缓存检查',e);}
function error(e,kind){const slot=status[kind||'table'];slot.state='failed';slot.error=String(e?.message||e).slice(0,300);updateStatus();console.warn('[椿中文字体]',slot.error);}
// Private translated cache is keyed by kind + original content hash + script version.
// Game caches retain Japanese originals; this cache is read only by this userscript.
const translatedCacheName='tsubaki-translated-resources-remote-1.3.0';
const cacheNative=typeof Cache==='undefined'?null:{match:Cache.prototype.match,put:Cache.prototype.put};
let translatedCachePromise;
function translatedCache(){
  return translatedCachePromise??=window.caches?.open(translatedCacheName).catch(()=>null)||Promise.resolve(null);
}
// Translation files contain data only; no remote code is executed.
const translationUrl='https://raw.githubusercontent.com/Tsubaki-serene/Test/main/zh-CN.json';
const translationCacheName='tsubaki-translation-dictionary-v1';
const translationCheckInterval=24*60*60*1000;
let translationsById=null,displayTranslations=Object.create(null),translationRevision='unavailable';
let translationUpdatePromise;
function getLanguageDictionary(){if(!translationsById)throw Error('译文尚未加载');return translationsById;}
function validateTranslation(text){
  if(typeof text!=='string'||text.length>4*1024*1024)throw Error('译文文件大小异常');
  const data=JSON.parse(text);
  if(data.schemaVersion!==1||data.game!=='charsapple'||typeof data.version!=='string')throw Error('译文格式或游戏不匹配');
  const cleanMap=(value,min,max)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('译文字典格式异常');
    const entries=Object.entries(value);
    if(entries.length<min||entries.length>max)throw Error('译文条数异常');
    const result=Object.create(null);
    for(const [key,text] of entries){
      if(!key||['__proto__','constructor','prototype'].includes(key)||typeof text!=='string'||text.length>65535)throw Error('译文条目格式异常');
      result[key]=text;
    }
    return result;
  };
  return {version:data.version,translationsById:cleanMap(data.translationsById,1000,100000),displayTranslations:cleanMap(data.displayTranslations,0,10000)};
}
async function parseTranslationBytes(bytes){
  if(bytes.length>4*1024*1024)throw Error('译文文件过大');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  return {data:validateTranslation(text),revision:await engine.hash(bytes),bytes};
}
async function openTranslationCache(){try{return await window.caches?.open(translationCacheName)||null;}catch{return null;}}
async function downloadTranslation(){
  if(!native.fetch)throw Error('浏览器不支持下载译文');
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await native.fetch(translationUrl,{signal:controller.signal,credentials:'omit',cache:'no-cache'});
    if(!response.ok)throw Error('译文下载失败 HTTP '+response.status);
    const declared=Number(response.headers.get('content-length'));
    if(declared>4*1024*1024)throw Error('译文文件过大');
    const bytes=new Uint8Array(await native.ab.call(response));
    return await parseTranslationBytes(bytes);
  }finally{clearTimeout(timer);}
}
async function storeTranslation(cache,loaded){
  if(!cache||!cacheNative)return false;
  try{
    await cacheNative.put.call(cache,translationUrl,new Response(loaded.bytes,{headers:{
      'content-type':'application/json; charset=utf-8',
      'x-tsubaki-checked-at':String(Date.now()),
      'x-tsubaki-dictionary-hash':loaded.revision
    }}));
    return true;
  }catch(e){console.warn('[椿汉化] 译文已加载，但本地缓存保存失败',e);return false;}
}
function activateTranslation(loaded,source){
  translationsById=loaded.data.translationsById;
  displayTranslations=loaded.data.displayTranslations;
  translationRevision=loaded.revision;
  status.translation={state:'applied',source,version:loaded.data.version,entries:Object.keys(translationsById).length};
  updateStatus();
}
async function checkTranslationUpdate(){
  if(translationUpdatePromise)return translationUpdatePromise;
  translationUpdatePromise=(async()=>{
    const loaded=await downloadTranslation();
    const saved=await storeTranslation(await openTranslationCache(),loaded);
    const pending=loaded.revision!==translationRevision;
    status.translation={...status.translation,update:pending?'pending-refresh':'current',cached:saved};
    updateStatus();
    return {version:loaded.data.version,changed:pending,saved,refreshRequired:pending};
  })();
  try{return await translationUpdatePromise;}finally{translationUpdatePromise=null;}
}
async function loadTranslation(){
  status.translation={state:'processing'};
  const cache=await openTranslationCache();
  if(cache&&cacheNative)try{
    const hit=await cacheNative.match.call(cache,translationUrl);
    if(hit){
      const loaded=await parseTranslationBytes(new Uint8Array(await native.ab.call(hit)));
      if(loaded.revision!==hit.headers.get('x-tsubaki-dictionary-hash'))throw Error('本地译文缓存校验失败');
      activateTranslation(loaded,'local-cache');
      const checked=Number(hit.headers.get('x-tsubaki-checked-at'))||0;
      if(Date.now()-checked>=translationCheckInterval)checkTranslationUpdate().catch(e=>{
        status.translation={...status.translation,update:'failed-using-cache',updateError:String(e?.message||e).slice(0,200)};
        updateStatus();console.warn('[椿汉化] 更新失败，继续使用缓存译文',e);
      });
      return;
    }
  }catch(e){console.warn('[椿汉化] 本地译文不可用，尝试重新下载',e);}
  try{
    const loaded=await downloadTranslation();
    const saved=await storeTranslation(cache,loaded);
    activateTranslation(loaded,'network');status.translation.cached=saved;
  }catch(e){
    status.translation={state:'failed',error:String(e?.message||e).slice(0,200)};
    updateStatus();console.warn('[椿汉化] 首次译文下载失败，本次保留日文',e);
  }
}
const translationReady=loadTranslation();

let worker,workerBroken=false,workerId=0;
const workerTasks=new Map(),translatedBodyPairs=new Map();
function stopWorker(reason){
  workerBroken=true;worker?.terminate();worker=null;
  for(const task of workerTasks.values())task.reject(reason);workerTasks.clear();
}
function getWorker(){
  if(!translationsById)return null;
  if(workerBroken||typeof Worker==='undefined')return null;
  if(worker)return worker;
  const source=createBinaryEngine.toString()+`
    let resourcePlans,displayTranslations,engine,dictionary;
    onmessage=async({data:m})=>{
      if(m.init){resourcePlans=m.plans;displayTranslations=m.display;dictionary=m.dictionary;engine=createBinaryEngine();return;}
      try{
        const bytes=new Uint8Array(m.bytes);let result;
        if(m.kind==='table')result=engine.replaceLanguageTable(bytes,dictionary);
        else if(m.kind==='assembly')result=engine.patchAssemblyLanguage(bytes,displayTranslations);
        else result=await engine.applyResourcePlan(bytes,resourcePlans[m.kind]);
        postMessage({id:m.id,bytes:result.bytes,proof:result.proof},[result.bytes.buffer]);
      }catch(e){postMessage({id:m.id,error:String(e?.message||e)});}
    };
  `;
  let objectUrl;
  try{
    objectUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    worker=new Worker(objectUrl);worker.onmessage=({data:m})=>{
      const task=workerTasks.get(m.id);if(!task)return;workerTasks.delete(m.id);
      if(m.error)task.reject(Error(m.error));else task.resolve({bytes:new Uint8Array(m.bytes),proof:m.proof});
    };
    worker.onerror=()=>stopWorker(Error('后台汉化不可用'));
    worker.postMessage({init:true,plans:resourcePlans,display:displayTranslations,dictionary:translationsById});
    return worker;
  }catch(e){stopWorker(e);return null;}finally{if(objectUrl)URL.revokeObjectURL(objectUrl);}
}
async function processResource(bytes,kind){
  if(kind==='table'||kind==='assembly'){await translationReady;getLanguageDictionary();}
  const active=getWorker();
  if(active){
    try{return await new Promise((resolve,reject)=>{
      const id=++workerId;workerTasks.set(id,{resolve,reject});
      try{active.postMessage({id,kind,bytes});}catch(e){workerTasks.delete(id);reject(e);}
    });}catch(e){
      // Asset validation failures retain originals. Only worker startup failure falls back.
      if(!workerBroken)throw e;
    }
  }
  await new Promise(resolve=>setTimeout(resolve,0));
  if(kind==='assembly')return engine.patchAssemblyLanguage(bytes,displayTranslations);
  if(kind==='table')return engine.replaceLanguageTable(bytes,getLanguageDictionary());
  return engine.applyResourcePlan(bytes,resourcePlans[kind]);
}
async function transform(bytes,url){
  if(!bytes?.length||bytes.length>LIMIT)return bytes;
  const kind=new URL(String(url),location.href).pathname.match(/localresources_(table|font|uiprefab|assembly|scene)(?:[._-]|[.]bundle)/i)?.[1]?.toLowerCase()||'table';
  if(kind==='scene')return bytes;
  if(kind==='table'||kind==='assembly'){await translationReady;if(!translationsById)return bytes;}
  const revision=(kind==='table'||kind==='assembly')?translationRevision:'static';
  const hash=await engine.hash(bytes),key=kind+':'+revision+':'+hash;
  const cacheUrl=new URL('/__tsubaki_translation__/remote-1.4.3/'+revision+'/'+kind+'/'+hash,location.origin).href;
  if(!jobs.has(key))jobs.set(key,(async()=>{try{
    status[kind]={state:'processing',path:new URL(String(url),location.href).pathname};
    const cache=await translatedCache();let result;
    if(cache&&cacheNative)try{
      const hit=await cacheNative.match.call(cache,cacheUrl);
      if(hit){const body=new Uint8Array(await native.ab.call(hit));
        if(body.length<=LIMIT&&await engine.hash(body)===hit.headers.get('x-tsubaki-result-hash'))result={bytes:body,proof:{cached:true}};
        else await cache.delete(cacheUrl);
      }
    }catch{}
    if(!result){
      result=await processResource(bytes,kind);
      if(cache&&cacheNative)try{
        const cached=new Response(result.bytes,{headers:{'x-tsubaki-result-hash':await engine.hash(result.bytes)}});
        await cacheNative.put.call(cache,cacheUrl,cached);
        // Retain at most two content versions of each resource kind.
        const entries=(await cache.keys()).filter(r=>new URL(r.url).pathname.includes('/'+kind+'/'));
        for(const old of entries.slice(0,Math.max(0,entries.length-2)))await cache.delete(old);
      }catch{}
    }
    if(result.bytes!==bytes){originalBodies.set(result.bytes,bytes);originalBodies.set(result.bytes.buffer,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));}
    status[kind]={state:'applied',...result.proof};
    return result.bytes;
  }catch(e){error(e,kind);return bytes;}})());
  const result=await jobs.get(key);
  if(result!==bytes)translatedBodyPairs.set(key,{translated:result,original:bytes});
  if(result!==bytes){originalBodies.set(result,bytes);originalBodies.set(result.buffer,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));}
  return result;
}
function rebuild(response,bytes){
  const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');
  const result=new Response(bytes,{status:response.status,statusText:response.statusText,headers});
  for(const name of ['url','type','redirected'])try{Object.defineProperty(result,name,{value:response[name]});}catch{}
  processed.add(result);originalResponses.set(result,response);return result;
}
if(native.fetch)window.fetch=async function(input,init){
  const response=await native.fetch(input,init),url=response.url||(typeof input==='string'?input:input?.url);
  if(!target(url)||!response.ok||String(init?.method||input?.method||'GET').toUpperCase()==='HEAD')return response;
  const backup=response.clone(),bytes=new Uint8Array(await native.ab.call(response));return rebuild(backup,await transform(bytes,url));
};
Response.prototype.arrayBuffer=async function(){
  const body=await native.ab.call(this);
  if(processed.has(this)){
    const origin=originalResponses.get(this);if(origin)originalBodies.set(body,await native.ab.call(native.clone.call(origin)));
    return body;
  }
  if(!this.ok||!target(this.url))return body;
  processed.add(this);const bytes=await transform(new Uint8Array(body),this.url);
  const result=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  originalBodies.set(result,body);return result;
};
Response.prototype.blob=async function(){
  if(processed.has(this)){
    const blob=await native.blob.call(this),origin=originalResponses.get(this);
    if(origin)originalBodies.set(blob,await native.blob.call(native.clone.call(origin)));return blob;
  }
  if(!this.ok||!target(this.url))return native.blob.call(this);
  processed.add(this);const bytes=await transform(new Uint8Array(await native.ab.call(this)),this.url);
  const blob=new Blob([bytes],{type:this.headers.get('content-type')||'application/octet-stream'});
  originalBodies.set(blob,new Blob([originalBodies.get(bytes)||bytes],{type:blob.type}));return blob;
};
Response.prototype.clone=function(){const copy=native.clone.call(this);if(processed.has(this))processed.add(copy);const origin=originalResponses.get(this);if(origin)originalResponses.set(copy,origin);return copy;};
const streams=new WeakMap();
if(native.body?.get&&native.body.configurable)Object.defineProperty(Response.prototype,'body',{...native.body,get(){
  const original=native.body.get.call(this);
  if(!original||processed.has(this)||!this.ok||!target(this.url))return original;
  if(streams.has(this))return streams.get(this);
  const response=this;let reader,cancelled=false;
  const stream=new ReadableStream({async start(controller){try{
    reader=original.getReader();const chunks=[];let total=0;
    for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>LIMIT)throw Error('文字表资源超出大小限制');chunks.push(value);}
    const bytes=new Uint8Array(total);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
    const result=await transform(bytes,response.url);if(!cancelled){controller.enqueue(result);controller.close();}
  }catch(e){if(!cancelled)controller.error(e);error(e,/localresources_font/i.test(response.url)?'font':'table');}finally{try{reader?.releaseLock();}catch{}}},cancel(reason){cancelled=true;return reader?.cancel(reason);}});
  streams.set(this,stream);return stream;
}});

// Persist original resources so turning the userscript off and refreshing restores Japanese.
function restoreCachedBody(value,seen=new WeakMap()){
  if(!value||typeof value!=='object')return value;
  if(originalBodies.has(value))return originalBodies.get(value);
  if(seen.has(value))return seen.get(value);
  if(value instanceof ArrayBuffer||ArrayBuffer.isView(value)){
    const bytes=value instanceof ArrayBuffer?new Uint8Array(value):new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
    for(const pair of translatedBodyPairs.values())if(bytes.length===pair.translated.length&&engine.eq(bytes,pair.translated)){
      const buffer=pair.original.buffer.slice(pair.original.byteOffset,pair.original.byteOffset+pair.original.byteLength);
      return value instanceof ArrayBuffer?buffer:value instanceof DataView?new DataView(buffer):new value.constructor(buffer);
    }
    return value;
  }
  if(value instanceof Blob||value instanceof Date)return value;
  if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)return value;
  const next=Array.isArray(value)?[]:{};seen.set(value,next);
  for(const key of Object.keys(value))next[key]=restoreCachedBody(value[key],seen);
  return next;
}
function cachedResourceUrl(key,value){
  return [key,key?.url,value?.url,value?.request?.url,value?.cacheKey].find(x=>typeof x==='string'&&target(x));
}
async function translateCacheRecord(value,url,seen=new WeakMap()){
  if(!value||typeof value!=='object')return value;
  if(seen.has(value))return seen.get(value);
  let bytes;
  if(value instanceof ArrayBuffer)bytes=new Uint8Array(value);
  else if(value instanceof Blob)bytes=new Uint8Array(await value.arrayBuffer());
  else if(ArrayBuffer.isView(value))bytes=new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  if(bytes){
    const result=await transform(bytes,url);
    const buffer=result.buffer.slice(result.byteOffset,result.byteOffset+result.byteLength);
    const out=value instanceof Blob?new Blob([result],{type:value.type}):ArrayBuffer.isView(value)?value instanceof DataView?new DataView(buffer):new value.constructor(buffer):buffer;
    originalBodies.set(out,value);return out;
  }
  if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)return value;
  const next=Array.isArray(value)?[]:{};seen.set(value,next);
  // Unity stores the resource body under response, data, body or bytes.
  for(const k of Object.keys(value))next[k]=['response','data','body','bytes'].includes(k)?await translateCacheRecord(value[k],url,seen):value[k];
  return next;
}
if(typeof IDBObjectStore!=='undefined')for(const name of ['get','getAll']){
  const original=IDBObjectStore.prototype[name];
  IDBObjectStore.prototype[name]=function(...args){
    const request=Reflect.apply(original,this,args);
    if(this.transaction?.db?.name?.startsWith('tsubaki-'))return request;
    let replaying=false;
    request.addEventListener('success',event=>{
      if(replaying)return;
      const raw=request.result;
      const entries=name==='getAll'&&Array.isArray(raw)?raw:[raw];
      const urls=entries.map(value=>cachedResourceUrl(args[0],value));
      if(!urls.some(Boolean))return;
      event.stopImmediatePropagation();
      Promise.all(entries.map((value,i)=>urls[i]?translateCacheRecord(value,urls[i]):value)).then(values=>{
        try{Object.defineProperty(request,'result',{configurable:true,value:name==='getAll'?values:values[0]});}catch(e){console.warn('[椿汉化] 缓存读取适配失败',e);}
      }).catch(e=>console.warn('[椿汉化] 缓存读取失败',e)).finally(()=>{
        replaying=true;request.dispatchEvent(new Event('success'));
      });
    });
    return request;
  };
}
if(typeof IDBObjectStore!=='undefined')for(const name of ['put','add']){
  const original=IDBObjectStore.prototype[name];
  IDBObjectStore.prototype[name]=function(value,...args){return Reflect.apply(original,this,[restoreCachedBody(value),...args]);};
}
if(typeof Cache!=='undefined'){
  const put=Cache.prototype.put;
  Cache.prototype.put=function(request,response){return Reflect.apply(put,this,[request,originalResponses.get(response)||response]);};
}
const xp=XMLHttpRequest.prototype,xstates=new WeakMap(),xopen=xp.open;
const xr=Object.getOwnPropertyDescriptor(xp,'response'),xs=Object.getOwnPropertyDescriptor(xp,'readyState');
function replay(xhr,state){if(xstates.get(xhr)!==state||state.aborted)return;
  state.pending=false;state.finished=true;state.replaying=true;
  try{for(const item of state.events){const event=typeof ProgressEvent==='function'&&item.type!=='readystatechange'?new ProgressEvent(item.type,item):new Event(item.type);xhr.dispatchEvent(event);}}
  finally{state.replaying=false;}
}
function watch(xhr){if(xhr.__tsubakiChineseXhr)return;Object.defineProperty(xhr,'__tsubakiChineseXhr',{value:true});
  for(const type of ['readystatechange','load','loadend'])xhr.addEventListener(type,function(event){
    const state=xstates.get(xhr);if(!state||state.replaying||state.finished||state.aborted||!state.target)return;
    if(!state.pending){
      if(xs.get.call(xhr)!==4||xhr.status<200||xhr.status>=300||!['arraybuffer','blob'].includes(xhr.responseType))return;
      const raw=xr.get.call(xhr);if(raw==null)return;
      state.pending=true;state.events=[];
      const work=raw instanceof ArrayBuffer?Promise.resolve(new Uint8Array(raw)):raw.arrayBuffer().then(b=>new Uint8Array(b));
      work.then(bytes=>transform(bytes,state.url)).then(bytes=>{state.data=xhr.responseType==='blob'?new Blob([bytes],{type:raw.type||'application/octet-stream'}):bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);originalBodies.set(state.data,raw);replay(xhr,state);}).catch(e=>{error(e,/localresources_font/i.test(state.url)?'font':'table');state.data=raw;replay(xhr,state);});
    }
    if(state.pending){event.stopImmediatePropagation();state.events.push({type,lengthComputable:!!event.lengthComputable,loaded:event.loaded||0,total:event.total||0});}
  },true);
  for(const type of ['abort','error','timeout'])xhr.addEventListener(type,()=>{const state=xstates.get(xhr);if(state)state.aborted=true;},true);
}
if(xr?.get&&xr.configurable&&xs?.get&&xs.configurable){
  xp.open=function(method,url,...args){xstates.set(this,{url:String(url),target:target(url),pending:false,finished:false,events:[]});watch(this);return xopen.call(this,method,url,...args);};
  Object.defineProperty(xp,'response',{...xr,get(){const state=xstates.get(this);return state?.finished&&'data'in state?state.data:xr.get.call(this);}});
  Object.defineProperty(xp,'readyState',{...xs,get(){const state=xstates.get(this);return state?.pending?3:xs.get.call(this);}});
}
})();
