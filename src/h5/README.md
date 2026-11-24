# H5 源码分片

`app.part1.js`、`app.part2.js`、`app.part3.js` 是同一份 `assets/app.js` 的顺序分片，只为便于在 GitHub 上保存与审阅。

构建时由根目录 `build.sh` 按文件名顺序拼回 `build/assets/app.js` 再打进 APK；不要单独加载或执行任何一个分片。
