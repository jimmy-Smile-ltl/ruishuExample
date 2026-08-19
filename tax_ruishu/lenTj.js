// lenTj.js — 天津电子税务局适配器 v2.1 (2026-08-16)
// numarrJoin 会给数组段插长度前缀, 真实结构 (173 值):
//   [3,70,<70>] [10,35,<35>] [7,12,<12>] [0,1,<1>] [6,16,<16>] [4,15,<15>] [2,4,<4>] [9,1,<1>] [13,1,<1>]
// 段内容 (来自内层解密真实明文):
//   segA(70) = [1,0,33,128, U4, 5, P5, 0,0, R4, 0,0,1, 0×11, 4,56,7,128, 0×7, 9, 0×24]
//   segB(35) = [3,1,106,129,51, R, 4,171, K1(2), 0, R,R,R, 8, R,R,R, 4, 15, host(15)]
//   segC(12) = [1, 0×7, 11,16, K2(2)]
//   segD(1)  = [0]
//   segE(16) = [1, 0×5, K3(2), 172,137,202,105,4, 0,0,0]
//   segF(15) = [0×12, 192,255,255,1]     ← 天津新增块 4
//   segG(4)  = fixedValue20() 的 4 值
//   segH(1)  = [0];  segI(1) = [0]
// 动态位: U=uuid(UA), P=platform串, R=随机, K3=encryptMode2(decrypt(keys22))尾2字节
//         K1/K2 派生待定位(暂用 keys19/keys21 decode 兜底)
const parser = require('../parser/');
const gv = require('../globalVarible');

const {
  fixedValue20,
  numToNumarr2,
  numToNumarr4,
  uuid,
  string2ascii,
  ascii2string,
  numarrAddTime,
  decode,
  decrypt,
  encryptMode2,
  numarrJoin,
} = parser;

function getBasearr(hostname, config) {
  const R = () => Math.floor((config.random || Math.random()) * 256);
  const em2 = encryptMode2(
    decrypt(ascii2string(gv.keys[22])),
    numarrAddTime(gv.keys[16], config.runTime, config.random)[0],
    0
  );
  // em2 返回已修剪, [16:18] 需要原始输出 → 重建: 尾部补 fill 字节
  const em2Raw = [...em2, ...new Array(em2[em2.length - 1] || 0).fill(em2[em2.length - 1] || 0)];
  const k3Tail = em2Raw.slice(16, 18);
  // [80..83] = keys19 num4; [121..122] = codeUid num2 (Cookie.js 的 getCodeUid)
  const k2 = numToNumarr2(config.codeUid);

  return numarrJoin(
    3, [
      1, 0, 33, 128,
      ...numToNumarr4(uuid(config['window.navigator.userAgent'])),  // [6..9] = uuid(UA)
      5,
      ...string2ascii(config['window.navigator.platform']),
      0, 0,
      R(), R(), R(), R(),
      0, 0, 1,
      ...new Array(11).fill(0),
      4, 56, 7, 128,
      ...new Array(7).fill(0),
      9,
      ...new Array(24).fill(0),
    ],
    10, [
      3, 1,
      ...numToNumarr4(config.r2mkaTime),  // [76..79] = r2mkaTime
      ...numToNumarr4(+ascii2string(gv.keys[19])),  // [80..83] = keys19 num4 (已定位)
      0,
      R(), R(), R(),
      8,
      R(), R(), R(),
      4, 15,
      ...string2ascii(hostname),
    ],
    7, [
      1,
      ...new Array(7).fill(0),
      11, 16,
      ...k2,
    ],
    0, [0],
    6, [
      1,
      ...new Array(5).fill(0),
      ...k3Tail,
      246, 146, 202, 105, 1,
      0, 0, 0,
    ],
    4, [
      ...new Array(11).fill(0),
      192, 255, 255, 1,
    ],
    2, fixedValue20(),
    9, [0],
    13, [0],
  )
}

Object.assign(getBasearr, {
  adapt: ['XE1YQRdNUFhXU1BXF1pRUFdYTVhBF15WTxdaVw=='],
  "XE1YQRdNUFhXU1BXF1pRUFdYTVhBF15WTxdaVw==": {
    // 域名 (base64, 运行时解码)
    devUrl: Buffer.from('ZXRheC50aWFuamluLmNoaW5hdGF4Lmdvdi5jbg==', 'base64').toString('utf8'),
    lastWord: 'T',
  },
  lens: 173,
});

module.exports = getBasearr;
