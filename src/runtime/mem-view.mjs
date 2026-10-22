// 分段线性内存视图（纯逻辑，浏览器 / Node 同构）
//
// ⚠️ 为什么不做整块拷贝：调试栈开 512MB（递归程序如 merge 需要），
//    暂停时若 `new Uint8Array(mem.buffer).slice(0)` 会每次拷贝 500MB+，
//    一断点就卡死/爆内存。所以只拷贝两段：低区（静态数据+堆，≤16MB）
//    和"当前 __stack_pointer 到内存末尾"（= 实际用掉的栈）。
//
// 调试暂停时只拷贝"低区（静态数据+堆）"和"实际用到的栈"，覆盖 512MB 调试栈
// 也不会让每次暂停都拷贝整块内存。这里按绝对地址读取，缺失区间补 0
// （等价于程序没写过那些地址）。
export class SparseMem {
  constructor(size, segments) {
    this.byteLength = size | 0;
    this.segs = (segments || []).slice().sort((a, b) => a.offset - b.offset);
    this.bytesCopied = this.segs.reduce((n, s) => n + s.bytes.length, 0);
  }
  _seg(addr) {
    const segs = this.segs;
    let lo = 0, hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segs[mid];
      if (addr < s.offset) hi = mid - 1;
      else if (addr >= s.offset + s.bytes.length) lo = mid + 1;
      else return s;
    }
    return null;
  }
  u8(addr) {
    const s = this._seg(addr);
    return s ? s.bytes[addr - s.offset] : 0;
  }
  sub(addr, len) {
    const out = new Uint8Array(len);
    for (const s of this.segs) {
      const a = Math.max(addr, s.offset), b = Math.min(addr + len, s.offset + s.bytes.length);
      if (b > a) out.set(s.bytes.subarray(a - s.offset, b - s.offset), a - addr);
    }
    return out;
  }
  dv(addr, len) { const b = this.sub(addr, len); return new DataView(b.buffer, 0, len); }
  read(addr, len) { return this.sub(addr, len).buffer; }
}

export const EMPTY_MEM = new SparseMem(0, []);
