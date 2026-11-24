# assets 说明

`index.html`、`style.css`、`devices.js` 直接提交；`app.js` 不提交，构建时由根目录 `build.sh` 把 `src/h5/app.part1.js`～`app.part3.js` 按顺序拼到 `build/assets/app.js`。

本地运行需要先 `cp config.example.js config.js` 并填入账号；`config.js` 已被 `.gitignore` 排除。
