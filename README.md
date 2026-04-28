# 宝宝颜值预测网页

这是一个可直接部署的网页项目，支持：

- 上传 1-2 张照片
- 预测宝宝五官与气质
- 生成结构化结果
- 直接生成宝宝证件照风格图片
- 未配置微信支付时，先走免支付测试模式
- 后续可接入微信 H5 支付

## 项目文件

- `index.html`：页面结构
- `styles.css`：页面样式
- `app.js`：前端交互和生成逻辑
- `server.py`：本地/线上服务端代理
- `requirements.txt`：Python 依赖
- `Procfile`：云平台启动命令
- `.env.example`：环境变量模板
- `secrets.local.example.json`：本地私密配置模板

## 本地运行

### 方式 1

双击运行 `launch_web.bat`

### 方式 2

在当前目录打开终端运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\start_server.ps1
```

然后打开：

[http://127.0.0.1:4173](http://127.0.0.1:4173)

## 环境变量

项目支持从环境变量读取密钥，不需要把真实 Key 写进前端。

建议部署时配置：

```bash
OPENAI_API_KEY=
DOUBAO_API_KEY=
DOUBAO_IMAGE_MODEL=doubao-seedream-5-0-260128
DOUBAO_IMAGE_URL=https://ark.cn-beijing.volces.com/api/v3/images/generations

WECHAT_PAY_MCHID=
WECHAT_PAY_APPID=
WECHAT_PAY_SERIAL_NO=
WECHAT_PAY_PRIVATE_KEY_PATH=
WECHAT_PAY_NOTIFY_URL=
WECHAT_PAY_RETURN_URL=
WECHAT_PAY_H5_APP_NAME=宝宝颜值预测
WECHAT_PAY_H5_APP_URL=
```

说明：

- 不配微信支付时，网页默认走测试免支付模式
- 配齐微信支付参数后，前端会自动切成 `支付 0.99 元并生成`
- `WECHAT_PAY_PRIVATE_KEY_PATH` 需要指向服务器上的 `apiclient_key.pem`

## Railway 部署

1. 把项目上传到 GitHub
2. 在 Railway 新建项目并导入这个仓库
3. 在 `Variables` 中填写环境变量
4. `Start Command` 填：

```bash
python server.py
```

5. 部署完成后，Railway 会给你一个公网域名

## Render 部署

1. 把项目上传到 GitHub
2. 在 Render 新建 `Web Service`
3. 选择这个仓库
4. `Build Command` 填：

```bash
pip install -r requirements.txt
```

5. `Start Command` 填：

```bash
python server.py
```

6. 在 `Environment` 中填写环境变量

## 上传 GitHub 前

- 不要提交真实密钥
- 不要提交 `secrets.local.json`
- 不要提交 `apiclient_key.pem` 这类证书私钥
- 推荐只提交代码、说明文档和模板文件

## 注意事项

- `secrets.local.json` 只适合本地测试
- 正式接微信支付时，必须使用公网 HTTPS 域名
- 小红书内打开网页时，微信 H5 支付建议跳系统浏览器完成
