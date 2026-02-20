# The Agency Dashboard - Setup Checklist

## ✅ Pre-Deployment Checklist

### 1️⃣ Gather Your API Credentials

- [ ] **Square Access Token**
  - Go to: https://developer.squareup.com/apps
  - Select your application
  - Under "Credentials", copy the **Access Token** (not the API Key)
  - Location ID: `LVNM3Z4RVRWDK` (already set)

- [ ] **Webflow API Token**
  - Go to: https://webflow.com/dashboard/account/integrations
  - Under "API Tokens", click "Generate API token"
  - Copy the token
  - Site ID: `6536f19431181574585ac1ce` (already set)
  - Collection ID: `68167d5a313e2fd6f18650c9` (already set)

### 2️⃣ Prepare Environment Variables

- [ ] Copy `.env.example` to `.env.local`
  ```bash
  cp .env.example .env.local
  ```

- [ ] Edit `.env.local` and fill in:
  ```
  NEXT_PUBLIC_SQUARE_ACCESS_TOKEN=<your_square_token>
  NEXT_PUBLIC_SQUARE_LOCATION_ID=LVNM3Z4RVRWDK
  NEXT_PUBLIC_WEBFLOW_TOKEN=<your_webflow_token>
  NEXT_PUBLIC_WEBFLOW_SITE_ID=6536f19431181574585ac1ce
  NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID=68167d5a313e2fd6f18650c9
  ```

- [ ] **IMPORTANT:** Do NOT commit `.env.local` to git (it's in `.gitignore`)

### 3️⃣ Test Locally (Optional but Recommended)

- [ ] Install dependencies:
  ```bash
  npm install
  ```

- [ ] Run local development server:
  ```bash
  npm run dev
  ```

- [ ] Open http://localhost:3000
- [ ] Verify dashboard loads and shows data
- [ ] Stop server: `Ctrl+C`

### 4️⃣ Initialize Git Repository

- [ ] Initialize git:
  ```bash
  git init
  git add .
  git commit -m "Initial commit: The Agency dashboard"
  ```

### 5️⃣ Create GitHub Repository

- [ ] Go to https://github.com/new
- [ ] Create new repository: `mounting-man-dashboard`
- [ ] Do NOT initialize with README/license (we have them)
- [ ] Copy the remote URL

- [ ] Add remote and push:
  ```bash
  git remote add origin https://github.com/<your-username>/mounting-man-dashboard.git
  git branch -M main
  git push -u origin main
  ```

### 6️⃣ Deploy to Vercel

**Option A: Via Vercel Dashboard (Recommended)**
- [ ] Go to https://vercel.com/new
- [ ] Click "Import Project"
- [ ] Paste your GitHub repo URL
- [ ] Click "Import"
- [ ] Under "Environment Variables", add:
  - `NEXT_PUBLIC_SQUARE_ACCESS_TOKEN` = (your Square token)
  - `NEXT_PUBLIC_SQUARE_LOCATION_ID` = `LVNM3Z4RVRWDK`
  - `NEXT_PUBLIC_WEBFLOW_TOKEN` = (your Webflow token)
  - `NEXT_PUBLIC_WEBFLOW_SITE_ID` = `6536f19431181574585ac1ce`
  - `NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID` = `68167d5a313e2fd6f18650c9`
- [ ] Click "Deploy"
- [ ] Wait 2-3 minutes for deployment

**Option B: Via Vercel CLI**
- [ ] Install Vercel CLI:
  ```bash
  npm install -g vercel
  ```
- [ ] Login:
  ```bash
  vercel login
  ```
- [ ] Deploy:
  ```bash
  vercel --prod
  ```
- [ ] When prompted for environment variables, paste from `.env.local`

### 7️⃣ Verify Deployment

- [ ] Deployment complete
- [ ] Go to your Vercel dashboard
- [ ] Find your project URL (e.g., `mounting-man-dashboard.vercel.app`)
- [ ] Click the link
- [ ] Dashboard loads and shows data ✓
- [ ] Check "Last updated" timestamp at bottom
- [ ] Wait 5 minutes, refresh page to verify auto-update works

### 8️⃣ Custom Domain (Optional)

- [ ] In Vercel project settings
- [ ] Go to "Domains"
- [ ] Add your custom domain (e.g., `dashboard.themountingman.com`)
- [ ] Update DNS records (Vercel provides instructions)
- [ ] Test custom domain

---

## 🔍 Verification Checklist

After deployment, confirm:

- [ ] Dashboard loads without errors
- [ ] "Last updated" timestamp is shown
- [ ] All metrics display (revenue, jobs, posts, etc.)
- [ ] Circular gauges render correctly
- [ ] Charts display 7-day revenue trend
- [ ] Geographic distribution shows percentages
- [ ] Footer shows "✓ All Systems Green"
- [ ] Auto-refresh works (wait 5 min, refresh, timestamp updates)

---

## 🆘 Troubleshooting

| Problem | Solution |
|---------|----------|
| "API connection failed" | Check `.env.local` has correct tokens, verify tokens are from Production (not Sandbox) |
| Dashboard shows "Loading..." forever | Check browser console (F12) for errors, verify API tokens are valid |
| Data looks old | Dashboard auto-refreshes every 5 min, refresh manually to test |
| 404 errors | Verify all files were created in correct directories |
| Build fails on Vercel | Check environment variables match exactly (including capitalization) |

---

## 📱 Access Your Dashboard

Once deployed, share this link with yourself:

```
https://mounting-man-dashboard.vercel.app
```

(Or your custom domain if you set one up)

---

## 🚀 Next Steps

1. Bookmark the dashboard
2. Add it to your home screen (mobile)
3. Check it daily for business metrics
4. Share with Malery/team if desired

---

## 📞 Need Help?

1. Check `DEPLOYMENT.md` for detailed instructions
2. Check `README.md` for overview
3. Verify `.env.local` file has correct values
4. Check Vercel logs for errors

---

**Status:** Ready to Deploy  
**Last Updated:** February 2026
