// 极简 wasm 二进制工具：只做调试插桩需要的部分。
//
// 关键事实（已用引擎实测确认）：
//   · Chrome/微软 DWARF 引擎的 `codeOffset` 是相对 **code 段内容起点**（即函数数量那个字节）的偏移
//   · 所以 moduleOffset = code.contentStart + engineOffset
//
// 插桩策略：
//   · 调试构建会先链接 wdb-stub（src/stub/），产物里已有 import "wdb"."probe"
//   · 插桩只在 DWARF 行表给出的语句起点插入 `i32.const siteId; call probeIdx`
//     —— 这些位置本来就是指令边界，且不需要解码指令
//   · 因此**不新增 import、不改函数索引**，只改 code 段（函数体长度 + 段长度）以及因此产生的整体位移
//
// 产物：{ wasm, sites: [{ id, origOffset, newOffset }] }
//   origOffset/newOffset 都是模块内绝对字节偏移，便于运行时交叉查表。

// ---------------------------------------------------------------- LEB128
export function readU32(bytes, pos) {
  let value = 0, shift = 0, b;
  do {
    if (pos >= bytes.length) throw new Error("LEB 越界");
    b = bytes[pos++];
    value |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return [value >>> 0, pos];
}
export function writeU32(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
/** 有符号 LEB（i32.const 用） */
export function writeS32(value) {
  const out = [];
  let v = value | 0, more = true;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    more = !((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0));
    if (more) b |= 0x80;
    out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------- 解析
/**
 * @returns {{
 *   entries: Array<{id:number,start:number,contentStart:number,contentEnd:number}>,
 *   code: {contentStart:number, bodies:Array<{index:number,sizeStart:number,bodyStart:number,end:number}>},
 *   funcImports: Array<{module:string,name:string,index:number}>,
 *   probeImportIndex: number,   // import 段里 wdb.probe 的函数索引（缺席为 -1）
 * }}
 */
export function parseWasm(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("不是 wasm 模块");
  }
  let pos = 8;
  const entries = [];
  let code = null;
  const allImports = [];        // 所有 import（含非函数）
  const importedGlobalTypes = [];
  let funcImportCount = 0;
  let definedGlobalTypes = [];
  const typeSignatures = [];    // 类型段：每个 func 类型的参数类型数组
  const typeResults = [];       // 类型段：每个 func 类型的返回值个数
  const funcTypeIndices = [];   // 函数段：每个定义函数对应的类型索引
  let importedFuncCount = 0;    // import 函数个数（函数索引空间前缀）
  const importFuncTypeIndices = []; // import 段：每个 import 函数的类型索引

  while (pos < bytes.length) {
    const id = bytes[pos];
    const start = pos;
    pos++;
    let size;
    [size, pos] = readU32(bytes, pos);
    const contentStart = pos;
    const contentEnd = pos + size;
    if (contentEnd > bytes.length) throw new Error("段长度越界");
    entries.push({ id, start, contentStart, contentEnd });

    if (id === 6) {                             // global 段
      let p = contentStart, count;
      [count, p] = readU32(bytes, p);
      for (let i = 0; i < count; i++) {
        const type = bytes[p++];      // 0x7f i32 / 0x7e i64 / 0x7d f32 / 0x7c f64
        p++;                          // mutability
        // 跳过 init expr：若干字节后以 0x0b end 结束（支持 global.get / i32.const 等简单形式）
        let depth = 0;
        for (;;) {
          const op = bytes[p++];
          if (op === 0x0b) break;
          if (op === 0x23 || op === 0x24) { let _i; [_i, p] = readU32(bytes, p); }        // global.get/set
          else if (op === 0x41) { while (bytes[p++] & 0x80); }                            // i32.const sleb
          else if (op === 0x42) { while (bytes[p++] & 0x80); }                            // i64.const
          else if (op === 0x43) { p += 4; }                                               // f32.const
          else if (op === 0x44) { p += 8; }                                               // f64.const
          else if (op === 0x6a || op === 0x6b || op === 0x6c) { /* add/sub/mul 之类无需参数 */ }
          else if (depth === 0) { /* 未知的简单 op，无立即数 */ }
          void depth;
        }
        definedGlobalTypes.push(type);
      }
    }
    if (id === 2) {                             // import 段
      let p = contentStart, count;
      [count, p] = readU32(bytes, p);
      for (let i = 0; i < count; i++) {
        let mlen; [mlen, p] = readU32(bytes, p);
        const module = new TextDecoder().decode(bytes.subarray(p, p + mlen)); p += mlen;
        let nlen; [nlen, p] = readU32(bytes, p);
        const name = new TextDecoder().decode(bytes.subarray(p, p + nlen)); p += nlen;
        const kind = bytes[p++];
        const isFunc = kind === 0;
        allImports.push({ module, name, kind, index: isFunc ? funcImportCount : -1 });
        if (isFunc) {
          funcImportCount++; importedFuncCount++;
          let it; [it, p] = readU32(bytes, p);                        // import func 的 type 索引
          importFuncTypeIndices.push(it);
        }
        if (kind === 3) importedGlobalTypes.push(bytes[p]);
        // 跳过 table/memory/global 的描述（func 的 type 索引已在上面读过）
        if (kind === 1) { p++; const fl = bytes[p - 1]; if (fl & 1) { let _m; [_m, p] = readU32(bytes, p); } let _l; [_l, p] = readU32(bytes, p); }
        else if (kind === 2) { const fl = bytes[p++]; if (fl & 1) { let _m; [_m, p] = readU32(bytes, p); } let _l; [_l, p] = readU32(bytes, p); }
        else if (kind === 3) { p += 2; }
        else if (kind !== 0) throw new Error("未知 import kind " + kind);
      }
    } else if (id === 1) {                      // type 段：函数签名
      let p = contentStart, count;
      [count, p] = readU32(bytes, p);
      for (let i = 0; i < count; i++) {
        const form = bytes[p++];                // 0x60 func
        if (form !== 0x60) throw new Error("type 段出现非 func 类型 " + form);
        let nParams; [nParams, p] = readU32(bytes, p);
        const params = [];
        for (let k = 0; k < nParams; k++) params.push(bytes[p++]);
        let nResults; [nResults, p] = readU32(bytes, p);
        p += nResults;
        typeSignatures.push(params);
        typeResults.push(nResults);
      }
    } else if (id === 3) {                      // function 段：函数 → 类型索引
      let p = contentStart, count;
      [count, p] = readU32(bytes, p);
      for (let i = 0; i < count; i++) {
        let t; [t, p] = readU32(bytes, p);
        funcTypeIndices.push(t);
      }
    } else if (id === 10) {                     // code 段
      let p = contentStart, count;
      [count, p] = readU32(bytes, p);
      const bodies = [];
      for (let i = 0; i < count; i++) {
        const sizeStart = p;
        let size;
        [size, p] = readU32(bytes, p);
        const bodyStart = p;
        // 解析 locals 声明（插桩要在函数末尾追加一个临时 i32 local）
        let lp = bodyStart, groups;
        [groups, lp] = readU32(bytes, lp);
        const groupList = [];
        for (let g = 0; g < groups; g++) {
          let n;
          [n, lp] = readU32(bytes, lp);
          const type = bytes[lp++];
          groupList.push({ n, type });
        }
        // local 0..n-1 是函数参数（wasm 规范），快照必须连同参数一起保存，
        // 否则带参函数（如 lambda 的 operator() 隐含 this）会让类型表整体错位
        const params = typeSignatures[funcTypeIndices[i]] || [];
        // 完整 local 索引表 = 参数 + 各 group 展开（缺一不可：追加临时 local 的
        // 索引 = 该表长度，漏了会覆盖函数自己的局部变量，直接破坏程序语义）
        const localTypes = [...params];
        for (const g of groupList) for (let k = 0; k < g.n; k++) localTypes.push(g.type);
        bodies.push({
          index: i, sizeStart, bodyStart, end: bodyStart + size, size,
          localsEnd: lp, groups: groupList, locals: localTypes,
          paramCount: params.length,
        });
        p = bodyStart + size;
      }
      code = { contentStart, count, bodies };
    }
    pos = contentEnd;
  }
  if (!code) throw new Error("没有 code 段");

  const probe = allImports.find((x) => x.kind === 0 && x.module === "wdb" && x.name === "probe");
  const pause = allImports.find((x) => x.kind === 0 && x.module === "wdb" && x.name === "pause");
  return {
    entries, code, funcImports: allImports.filter((x) => x.kind === 0),
    probeImportIndex: probe ? probe.index : -1,
    pauseImportIndex: pause ? pause.index : -1,
    globalTypes: [...importedGlobalTypes, ...definedGlobalTypes],
    typeSignatures, typeResults, funcTypeIndices, importFuncTypeIndices,
  };
}

/** 函数体第一个指令的模块内偏移（跳过 locals 声明） */
export function firstInstrOffset(bytes, body) {
  let p = body.bodyStart;
  let count;
  [count, p] = readU32(bytes, p);
  for (let i = 0; i < count; i++) {
    let n;
    [n, p] = readU32(bytes, p);   // 连续同类型局部变量个数
    p++;                          // 类型字节
  }
  return p;
}

// ---------------------------------------------------------------- 插桩
// ⚠️ 插桩踩过的两个致命坑（改动前必读）：
//   1) local 索引表必须包含**函数参数**（wasm 规范：local 0..n-1 是参数）。
//      漏了参数 → 类型表整体错位 → i64.store 配 i32 → "插桩后的 wasm 无法编译"。
//      典型触发：#define int long long 的 i64 变量、lambda 的 operator()（隐含 this）。
//   2) 插桩点必须落在**操作数栈为空**的指令边界。插入的是 block…br_if…end 结构，
//      若落在表达式中间（栈上有中间值），block 的 end/br 会截断这些值，
//      导致程序结果错乱（曾出现输出 6 变 0）。computeEmptyStackOffsets 负责筛选，
//      行首 offset 栈非空时回退/前找到最近栈空点；多个语句共用同一回退点则用别名合并。
//
// 每个语句起点的插桩序列（含 locals 快照，供 DWARF 引擎读变量）：
//   block
//     i32.const siteId ; call probe            → ptr（0 表示这次不暂停）
//     local.set $tmp ; local.get $tmp ; i32.eqz ; br_if 0
//     for each local i:  local.get $tmp ; i32.const i*8 ; i32.add ; local.get i ; <store>
//     call pause                               ← 这里阻塞，引擎可以读 locals
//   end
const STORE_OPS = { 0x7f: [0x36, 2], 0x7e: [0x37, 3], 0x7d: [0x38, 2], 0x7c: [0x39, 3] };

/**
 * 线性扫描函数体，算出"操作数栈为空"的指令偏移集合（相对模块，即绝对偏移）。
 * 只处理结构化控制流的常规形态（-O0 的 clang 输出）：
 *   · 每条指令按 push/pop 数更新栈深，块入口记录高度、end 恢复
 *   · br/br_if 落到最近未闭合块（保守：视为栈清空到块入口）
 *   · unreachable / br_table 等复杂情况 → 抛错（调用方放弃整个函数体）
 * 候选插桩点必须命中这个集合，否则会截断中间操作数、破坏程序语义。
 */
function computeEmptyStackOffsets(bytes, body, sigCtx) {
  const empty = new Set();
  const blockStack = [];          // 每层块进入时的栈深
  let depth = 0;                  // 当前操作数栈深
  let poisoned = false;           // return/br 之后线性不可达：不再记 empty，只推进位置
  let unknown = false;            // 遇到未知指令/无法解码：本层块内深度不可信，end 时重新对齐
  let p = body.localsEnd;
  // call 的栈效应：funcIdx → {pop, push}。函数索引空间 = import 函数在前。
  const callSignature = (fidx) => {
    const tidx = fidx < sigCtx.importedFuncCount
      ? (sigCtx.importFuncTypeIndices[fidx] ?? -1)
      : (sigCtx.funcTypeIndices[fidx - sigCtx.importedFuncCount] ?? -1);
    const params = tidx >= 0 ? (sigCtx.typeSignatures[tidx] || []) : [];
    const results = tidx >= 0 ? (sigCtx.typeResults[tidx] ?? 0) : 0;
    return { pop: params.length, push: results };
  };
  let stopped = false;            // 遇到无法线性解码的指令：保留已扫出的点，不再往后扫
  while (p < body.end && !stopped) {
    if (!poisoned && !unknown && depth === 0) empty.add(p);   // 只记录"可达且可信且栈空"的指令边界
    const op = bytes[p++];
    const pop = (n) => { depth = Math.max(0, depth - n); };
    const push = (n) => { depth += n; };
    switch (op) {
      case 0x01: break;                                               // nop
      case 0x00:                                                      // unreachable：清栈且后文线性不可达
        depth = 0; poisoned = true; break;
      case 0x1b:                                                      // select（弹 3 压 1）
        depth = Math.max(0, depth - 3) + 1; break;
      case 0xc0: case 0xc1: case 0xc2: case 0xc3: case 0xc4:            // 符号扩展（extend8/16/32）
        depth = Math.max(0, depth - 1) + 1; break;
      case 0x1c: {                                                    // select (typed)：vec(valtype)
        let n = 0, sh = 0;
        for (;;) { const b = bytes[p++]; n |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; }
        p += n;                                                       // 类型列表
        depth = Math.max(0, depth - 3) + 1; break;
      }
      case 0xd0:                                                      // ref.null <heaptype>
        p++; depth += 1; break;
      case 0xd1:                                                      // ref.is_null
        depth = Math.max(0, depth - 1) + 1; break;
      case 0xd2:                                                      // ref.func <funcidx>
        while (bytes[p++] & 0x80) {}
        depth += 1; break;
      case 0xfc: {                                                    // 前缀指令（饱和截断等）
        let sub = 0, sh = 0;
        for (;;) { const b = bytes[p++]; sub |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; }
        if (sub <= 7) { depth = Math.max(0, depth - 1) + 1; }           // trunc_sat 系列
        else if (sub === 8) { while (bytes[p++] & 0x80) {} while (bytes[p++] & 0x80) {} depth = Math.max(0, depth - 3); }
        else if (sub === 9) { while (bytes[p++] & 0x80) {} }
        else if (sub === 10) { while (bytes[p++] & 0x80) {} while (bytes[p++] & 0x80) {} depth = Math.max(0, depth - 3); }
        else if (sub === 11) { while (bytes[p++] & 0x80) {} depth = Math.max(0, depth - 3); }
        else { stopped = true; break; }
        break;
      }
      case 0x02: case 0x03: case 0x04: {                              // block / loop / if
        // ⚠️ if 会把条件值弹掉，进入块内的深度是 depth-1；以前一律 push(depth)，
        //    导致每个 if 之后深度永久 +1，`depth === 0` 再也不成立 → 后面再也找不到空点。
        const inner = op === 0x04 ? Math.max(0, depth - 1) : depth;
        blockStack.push(inner);
        p++;                                                          // blocktype 立即数（单字节）
        break;
      }
      case 0x05:                                                      // else
        depth = blockStack[blockStack.length - 1] ?? depth; poisoned = false; unknown = false; break;
      case 0x0b:                                                      // end
        depth = blockStack.pop() ?? 0; poisoned = false; unknown = false;
        if (!blockStack.length && stopped) stopped = false;           // 回到函数最外层：重新开始信任
        break;
      case 0x0c: case 0x0d: {                                         // br / br_if
        let label = 0, sh = 0;
        for (;;) { const b = bytes[p++]; label |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; }
        if (op === 0x0c) { poisoned = true; }                         // 无条件跳转后线性不可达
        else depth = Math.max(0, depth - 1);                          // br_if 弹条件
        break;
      }
      case 0x0e:                                                      // br_table：立即数是标签表，无法线性推进
        stopped = true; break;
      case 0x0f:                                                      // return：之后线性不可达
        poisoned = true;
        break;
      // —— load/store：align + offset 两个立即数 ——
      case 0x28: case 0x29: case 0x2a: case 0x2b: case 0x2c: case 0x2d:
      case 0x2e: case 0x2f: case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39: case 0x3a: case 0x3b:
      case 0x3c: case 0x3d: case 0x3e:
        depth = Math.max(0, depth - (OP_STACK_EFFECT[op] ? OP_STACK_EFFECT[op][0] : 0));
        if (OP_STACK_EFFECT[op]) depth += OP_STACK_EFFECT[op][1];
        // align(ULEB) + offset(ULEB)：offset 可能 >127（如 0xcc 0x04 = 524），必须按 LEB 读
        while (bytes[p++] & 0x80) {}
        while (bytes[p++] & 0x80) {}
        break;
      case 0x3f: case 0x40:                                          // memory.size / memory.grow：只有 memidx 一个字节
        depth = Math.max(0, depth - (OP_STACK_EFFECT[op] ? OP_STACK_EFFECT[op][0] : 0));
        if (OP_STACK_EFFECT[op]) depth += OP_STACK_EFFECT[op][1];
        p += 1;
        break;
      // —— call：效应由函数签名决定（类型段已解析）——
      case 0x10: {
        let fidx = 0, sh = 0;
        for (;;) { const b = bytes[p++]; fidx |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; }
        const sig = callSignature(fidx);
        depth = Math.max(0, depth - sig.pop) + sig.push;
        break;
      }
      // —— call_indirect：type 索引 + table 索引两个 ULEB ——
      case 0x11: {
        let tidx = 0, sh = 0;
        for (;;) { const b = bytes[p++]; tidx |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; }
        while (bytes[p++] & 0x80) {}                                  // table index
        const params = sigCtx.typeSignatures[tidx] || [];
        depth = Math.max(0, depth - params.length - 1) + 1;           // 参数 + table idx，压返回
        break;
      }
      // —— 带一个 ULEB 立即数 ——
      case 0x20: case 0x21: case 0x22: case 0x23: case 0x24:
      case 0x25: case 0x26:
        depth = Math.max(0, depth - (OP_STACK_EFFECT[op] ? OP_STACK_EFFECT[op][0] : 0));
        if (OP_STACK_EFFECT[op]) depth += OP_STACK_EFFECT[op][1];
        while (bytes[p++] & 0x80) {}
        break;
      // —— 带一个 SLEB 立即数 ——
      case 0x41: case 0x42:                                          // i32/i64.const：SLEB
        depth += OP_STACK_EFFECT[op][1];
        while (bytes[p++] & 0x80) {}
        break;
      case 0x43:                                                      // f32.const：4 字节原始数据
        depth += 1; p += 4; break;
      case 0x44:                                                      // f64.const：8 字节原始数据
        depth += 1; p += 8; break;
      default: {
        const io = OP_STACK_EFFECT[op];
        if (io == null) {
          // 未知指令：**不要永久放弃**（那会让后面所有语句塌陷到最后一个空点，见文件头注释）。
          // 策略：本层块内深度不可信（unknown=true，期间不记录空点），
          // 等遇到 end/else 用块入口深度重新对齐，之后继续正常扫描。
          // 只有在函数最外层（blockStack 为空）都拿不到对齐时才算彻底放弃。
          if (globalThis.__WDB_STACK_DBG) {
            console.error(`[stack-sim] unknown op 0x${op.toString(16)} at ${p - 1} (body ${body.index}, depth ${depth}, blocks ${blockStack.length})`);
          }
          unknown = true;
          break;
        }
        depth = Math.max(0, depth - io[0]) + io[1];
        break;
      }
    }
  }
  if (globalThis.__WDB_STACK_DBG) {
    const arr = [...empty].sort((a, b) => a - b);
    console.error(`[stack-sim] body ${body.index} range ${body.localsEnd}..${body.end} empty=${arr.length}` +
      ` stopped=${stopped} visitedEnd=${p >= body.end}` +
      ` first=[${arr.slice(0, 4).join(",")}] last=[${arr.slice(-4).join(",")}]`);
  }
  return empty;
}
// 栈效应表：op -> [pop, push]。
//
// ⚠️ 这张表**漏一条指令的代价是灾难性的**：`computeEmptyStackOffsets` 以前遇到未知指令会
//    `stopped = true` 永久放弃该函数后续扫描，于是"最后一个已知空点"成了后面所有语句的
//    唯一落点 —— 十几条语句挤在同一个探针上，断点看着"已验证"却永不触发、单步直接跑完。
//    真实事故：`ceil(log2(n))` 产生的 `f64.ceil`(0x9b) 不在表里，main 后半段全部塌陷。
//    所以这里按 wasm 规范**按区间**把 0x45..0xbf 的数值指令全部补全，不再靠"常见子集"。
const OP_STACK_EFFECT = (() => {
  const t = {};
  const range = (from, to, pop, push) => { for (let op = from; op <= to; op++) t[op] = [pop, push]; };
  range(0x45, 0x45, 1, 1);   // i32.eqz
  range(0x46, 0x4f, 2, 1);   // i32 比较
  range(0x50, 0x50, 1, 1);   // i64.eqz
  range(0x51, 0x5a, 2, 1);   // i64 比较
  range(0x5b, 0x60, 2, 1);   // f32 比较
  range(0x61, 0x66, 2, 1);   // f64 比较
  range(0x67, 0x69, 1, 1);   // i32.clz/ctz/popcnt
  range(0x6a, 0x78, 2, 1);   // i32 算术/位
  range(0x79, 0x7b, 1, 1);   // i64.clz/ctz/popcnt
  range(0x7c, 0x8a, 2, 1);   // i64 算术/位
  range(0x8b, 0x91, 1, 1);   // f32 一元（abs..sqrt）
  range(0x92, 0x98, 2, 1);   // f32 二元
  range(0x99, 0x9f, 1, 1);   // f64 一元（abs..sqrt）—— 0x9b=f64.ceil 就是漏掉的那条
  range(0xa0, 0xa6, 2, 1);   // f64 二元
  range(0xa7, 0xbf, 1, 1);   // 类型转换 / reinterpret（全部一元）
  t[0x1a] = [1, 0];          // drop
  t[0x1b] = [3, 1];          // select
  // 带立即数的（load/store/call/local 等在 switch 里单独处理，这里只提供栈效应）
  range(0x28, 0x35, 1, 1);   // *.load
  range(0x36, 0x3e, 2, 0);   // *.store
  t[0x3f] = [0, 1];          // memory.size
  t[0x40] = [1, 1];          // memory.grow
  t[0x20] = [0, 1]; t[0x21] = [1, 0]; t[0x22] = [1, 1];
  t[0x23] = [0, 1]; t[0x24] = [1, 0]; t[0x25] = [0, 0]; t[0x26] = [0, 0];
  t[0x41] = [0, 1]; t[0x42] = [0, 1]; t[0x43] = [0, 1]; t[0x44] = [0, 1];
  return t;
})();


/**
 * 在给定模块偏移处插入探针（带 locals 快照）。
 * @param {Uint8Array} bytes 原始（未插桩）wasm
 * @param {Array<{id:number, offset:number}>} sites  offset 为**模块内绝对偏移**，且必须是语句起点
 * @returns {{wasm:Uint8Array, sites:Array<{id:number,origOffset:number,newOffset:number,body:number}>,
 *            dropped:Array, probeImportIndex:number, pauseImportIndex:number,
 *            bodyLocals:Array<Array<number>>, codeContentStartOrig:number}}
 */
export function instrumentWasm(bytes, sites) {
  const info = parseWasm(bytes);
  if (info.probeImportIndex < 0 || info.pauseImportIndex < 0) {
    throw new Error('产物里缺少 import "wdb"."probe"/"wdb"."pause"（调试构建需要先链接 wdb-stub，见 src/stub/）');
  }
  const probeIdx = info.probeImportIndex;
  const pauseIdx = info.pauseImportIndex;
  const globalTypes = info.globalTypes || [];
  const { code } = info;

  // 1) 把 site 归到函数体（用 orig 相对位置）；非法位置丢弃（宁可少插，不要插坏）
  const perBody = new Map();
  const dropped = [];
  const sortedSites = [...sites].sort((a, b) => a.offset - b.offset);
  // 栈深缓存：body.index -> Set<函数体相对偏移>（操作数栈为空的合法插桩点）
  const emptyStackCache = new Map();
  const emptyStackErr = new Map();
  // import 函数个数 = probe/pause 等 import 总数（函数索引空间前缀），由 parseWasm 返回
  const importedFuncCountLocal = info.funcImports.length;
  const stackEmptyAt = (body) => {
    if (!emptyStackCache.has(body.index)) {
      try { emptyStackCache.set(body.index, computeEmptyStackOffsets(bytes, body, {
        typeSignatures: info.typeSignatures, typeResults: info.typeResults,
        funcTypeIndices: info.funcTypeIndices, importFuncTypeIndices: info.importFuncTypeIndices,
        importedFuncCount: importedFuncCountLocal,
      })); }
      catch (e) { emptyStackCache.set(body.index, null); emptyStackErr.set(body.index, (e && e.message) || String(e)); }   // 模拟失败 → 该函数全部放弃插桩
    }
    return emptyStackCache.get(body.index);
  };
  for (const s of sortedSites) {
    const body = code.bodies.find((b) => s.offset >= b.bodyStart && s.offset < b.end);
    if (!body) { dropped.push({ ...s, why: "不在任何函数体内" }); continue; }
    if (s.offset < body.localsEnd) { dropped.push({ ...s, why: "落在 locals 声明区" }); continue; }
    // 插桩序列是 block…end 结构：落在"操作数栈非空"的位置会截断中间值、改变语义
    // （表现为输出错乱甚至 wasm 校验失败）。只允许栈空的真·语句起点。
    const empty = stackEmptyAt(body);
    if (empty === null) { dropped.push({ ...s, why: "栈模拟失败，保守放弃（" + (emptyStackErr.get(body.index) || "?") + "）" }); continue; }
    if (!empty.has(s.offset)) {
      // DWARF 行首 offset 可能落在表达式中间（-O0 下前置指令已垫高栈）。
      // 先向前回退（语义最接近该语句起点），找不到再向后找（同一语句内靠后的
      // 栈空点也行：暂停时上报的行号仍是这一行）。多个站点撞到同一位置时
      // 只插一份探针，站点之间以别名共享（见下方 byRel 分组）。
      let fallback = null, forward = null;
      for (const off of empty) {
        if (off <= body.localsEnd) continue;               // locals 区不可插
        if (off < s.offset) { if (fallback == null || off > fallback) fallback = off; }
        else if (off > s.offset) { if (forward == null || off < forward) forward = off; }
      }
      const chosen = fallback != null ? fallback : forward;
      if (chosen == null) { dropped.push({ ...s, why: "函数里没有可用的栈空点" }); continue; }
      if (!perBody.has(body.index)) perBody.set(body.index, []);
      perBody.get(body.index).push({ rel: chosen - body.bodyStart, id: s.id, requested: s.offset });
      continue;
    }
    if (!perBody.has(body.index)) perBody.set(body.index, []);
    perBody.get(body.index).push({ rel: s.offset - body.bodyStart, id: s.id });
  }
  for (const list of perBody.values()) list.sort((a, b) => a.rel - b.rel);

  // 2) 每个函数体：追加一个临时 i32 local + 在站点处插入快照序列
  const bodyBlobs = code.bodies.map((body) => {
    const tempIdx = body.locals.length;                 // 追加在最后，不影响已有 local 索引
    const localsBytes = [
      ...writeU32(body.groups.length + 1),
      ...body.groups.flatMap((g) => [...writeU32(g.n), g.type]),
      ...writeU32(1), 0x7f,
    ];
    const seqFor = (id) => {
      const out = [
        0x02, 0x40,                                     // block void
        0x41, ...writeS32(id | 0),                      // i32.const siteId
        0x10, ...writeU32(probeIdx),                    // call probe
        0x21, ...writeU32(tempIdx),                     // local.set $tmp
        0x20, ...writeU32(tempIdx), 0x45,               // local.get $tmp ; i32.eqz
        0x0d, 0x00,                                     // br_if 0（ptr==0 时跳过）
      ];
      const localsBytesLen = body.locals.length * 8;
      for (let i = 0; i < body.locals.length; i++) {
        const op = STORE_OPS[body.locals[i]];
        if (!op) continue;                              // v128/其他类型暂不保存
        out.push(
          0x20, ...writeU32(tempIdx),                   // local.get $tmp（快照基址）
          0x41, ...writeS32(i * 8), 0x6a,               // i32.const off ; i32.add
          0x20, ...writeU32(i),                         // local.get i
          op[0], op[1], 0x00,                           // <store> align, offset=0
        );
      }
      // globals 快照（引擎读取全局/TLS/栈指针时会要 getWasmGlobal）
      for (let g = 0; g < globalTypes.length; g++) {
        const op = STORE_OPS[globalTypes[g]];
        if (!op) continue;
        out.push(
          0x20, ...writeU32(tempIdx),
          0x41, ...writeS32(localsBytesLen + g * 8), 0x6a,
          0x23, ...writeU32(g),                         // global.get g
          op[0], op[1], 0x00,
        );
      }
      out.push(0x10, ...writeU32(pauseIdx), 0x0b);      // call pause ; end
      return out;
    };
    // 同一 rel 可能被多个站点共享（相邻语句的"栈空回退点"撞在一起）：
    // 位置只插一份探针序列，组内第一个 id 是宿主 id，其余记为别名
    const raw = perBody.get(body.index) || [];
    const byRel = new Map();
    for (const s of raw) {
      if (!byRel.has(s.rel)) byRel.set(s.rel, { rel: s.rel, id: s.id, aliases: [], requested: s.requested });
      else byRel.get(s.rel).aliases.push(s.id);
    }
    const seqs = [...byRel.values()].map((g) => ({ ...g, seq: seqFor(g.id) }));
    seqs.sort((a, b) => a.rel - b.rel);
    const parts = [Uint8Array.from(localsBytes)];
    let cursor = body.localsEnd;
    for (const s of seqs) {
      const at = body.bodyStart + s.rel;
      parts.push(bytes.subarray(cursor, at));
      parts.push(Uint8Array.from(s.seq));
      cursor = at;
    }
    parts.push(bytes.subarray(cursor, body.end));
    let total = 0;
    for (const p of parts) total += p.length;
    return { body, parts, payloadLen: total, seqs, localsLen: localsBytes.length };
  });

  // 3) 重建 code 段
  const pieces = [Uint8Array.from(writeU32(code.count))];
  for (const blob of bodyBlobs) {
    pieces.push(Uint8Array.from(writeU32(blob.payloadLen)));
    for (const p of blob.parts) pieces.push(p);
  }
  const newCodeContent = concat(pieces);

  const out = [bytes.subarray(0, 8)];
  for (const e of info.entries) {
    if (e.id === 10) {
      out.push(Uint8Array.from([10]));
      out.push(Uint8Array.from(writeU32(newCodeContent.length)));
      out.push(newCodeContent);
    } else {
      out.push(bytes.subarray(e.start, e.contentEnd));
    }
  }
  const wasm = concat(out);

  // 4) 计算每站点在新模块里的偏移（用于调试；运行时用 origOffset + 站点表即可）
  const after = parseWasm(wasm);
  const outSites = [];
  for (const blob of bodyBlobs) {
    const bodyNew = after.code.bodies[blob.body.index];
    let added = blob.localsLen - (blob.body.localsEnd - blob.body.bodyStart);
    for (const s of blob.seqs) {
      const newRel = (s.rel - (blob.body.localsEnd - blob.body.bodyStart)) + blob.localsLen + (added - (blob.localsLen - (blob.body.localsEnd - blob.body.bodyStart)));
      const base = {
        // 实际插桩的原始模块偏移（回退后 = 栈空回退点，而非引擎给的行首请求点）
        origOffset: blob.body.bodyStart + s.rel,
        // 引擎原始请求点（仅用于诊断/日志；反查行号请用 origOffset）
        requestedOffset: s.requested ?? blob.body.bodyStart + s.rel,
        newOffset: bodyNew.bodyStart + newRel,
        body: blob.body.index,
      };
      outSites.push({ ...base, id: s.id, aliases: s.aliases });
      // 别名站点与宿主站点同位置，adapter/worker 据此把断点命中合并处理
      for (const alias of s.aliases) outSites.push({ ...base, id: alias, aliasOf: s.id });
      added += s.seq.length;
    }
  }

  return {
    wasm,
    sites: outSites,
    dropped,
    probeImportIndex: probeIdx,
    pauseImportIndex: pauseIdx,
    bodyLocals: code.bodies.map((b) => b.locals),
    globalTypes,
    codeContentStartOrig: code.contentStart,
  };
}

function concat(list) {
  let total = 0;
  for (const x of list) total += x.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const x of list) { out.set(x, at); at += x.length; }
  return out;
}
