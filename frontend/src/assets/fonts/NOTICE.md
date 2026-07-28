# 字体来源与授权

`roam-symbols-box.woff2` / `roam-symbols-misc.woff2` 是终端符号补字集，由以下字体经
fontTools 子集化（仅保留符号区段、去 hinting）生成，字体内部名称表原样保留：

| 输出 | 源字体 | 授权 |
|---|---|---|
| roam-symbols-box.woff2 | Noto Sans Mono | SIL Open Font License 1.1 |
| roam-symbols-misc.woff2 | Noto Sans Symbols 2 | SIL Open Font License 1.1 |

Noto 字体版权归 Google Inc. 所有，以 SIL OFL 1.1 发布：
https://openfontlicense.org/ · https://github.com/notofonts/notofonts.github.io

OFL 允许自由使用、修改与再分发（含随软件打包），要求保留本声明、且衍生字体不得单独售卖。
CSS 里以 font-family: 'Roam Symbols' 引用，字体文件内部仍保留 Noto 的名称记录
（name 表不能清空——清空后 Chrome 的 OTS 会判定字体非法、静默拒绝加载，符号又会变回 tofu）。

重新生成（源字体路径按本机 fonts-noto 安装位置）：

```
pyftsubset /usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf \
  --unicodes=U+2190-21FF,U+2500-257F,U+2580-259F,U+25A0-25FF \
  --flavor=woff2 --layout-features= --no-hinting --desubroutinize \
  --output-file=roam-symbols-box.woff2

pyftsubset /usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf \
  --unicodes=U+2300-23FF,U+2600-26FF,U+2700-27BF,U+2B00-2BFF \
  --flavor=woff2 --layout-features= --no-hinting --desubroutinize \
  --output-file=roam-symbols-misc.woff2
```
