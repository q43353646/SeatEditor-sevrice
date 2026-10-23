# 会议座位编辑系统

## 本地开发
静态文件直接打开 `index.html` 即可，但登录和用户管理需要后端 API。

## 部署到 Cloudflare Pages

### 1. 推送到 GitHub
```bash
cd seat-queryer
git init
git add .
git commit -m "init"
git remote add origin XXX.git
git push -u origin main
```

### 2. Cloudflare Pages 连接仓库
1. 登录 Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
2. 选择 仓库
3. 构建配置：
   - **Framework preset**: None
   - **Build command**: 留空
   - **Build output directory**: `/` （根目录）
   - **Root directory**: `/` （根目录）

### 3. 设置环境变量
在 Pages 项目 → Settings → Environment variables 中添加：

| 变量名 | 值 |
|---|---|
| `数据库_URL` | `https://XX.XXX.XX` |
| `公钥` | Supabase anon public key |
| `私钥` | Supabase service_role key（保密） |
| `SECRET` | 自定义随机字符串|
| `ROOM` | `default` |

> **注意**：`私钥` 和 `SECRET` 一定要设为 **Secret**（加密），不要设成 plaintext。

### 4. 部署
每次 push 到 main 分支，Cloudflare Pages 自动构建部署。
访问 `https://<your-project>.pages.dev` 即可。

## 目录结构
```
├── index.html           # 登录页
├── admin.html           # 用户管理页（管理员）
├── seat_editor.html     # 排座编辑主页面
├── functions/
│   └── api/
│       └── [[path]].js  # 所有 /api/* 接口（Pages Functions）
└── package.json         # 不需要（Pages Functions 无依赖）
```

## API 路由
- `POST /api/login` — 登录
- `GET /api/config` — 获取前端 Supabase 配置
- `GET /api/users` — 用户列表（admin）
- `POST /api/users` — 新增用户（admin）
- `DELETE /api/users/:id` — 删除用户（admin）
- `GET /api/query/:phone` — 按手机号查座位
