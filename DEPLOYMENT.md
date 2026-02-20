# The Agency - Dashboard Deployment Guide

## 🎯 Quick Start (5 minutes)

### Step 1: Get Your API Tokens

**Square API Token:**
1. Go to https://developer.squareup.com/apps
2. Select your application
3. Copy your **Access Token** (Production)
4. Copy your **Location ID** (you have: LVNM3Z4RVRWDK)

**Webflow API Token:**
1. Go to https://webflow.com/dashboard/account/integrations
2. Click "Generate API token"
3. Copy the token

### Step 2: Set Up Environment Variables

```bash
# In the project directory, create .env.local
cp .env.example .env.local

# Edit .env.local and fill in:
NEXT_PUBLIC_SQUARE_ACCESS_TOKEN=your_square_token_here
NEXT_PUBLIC_SQUARE_LOCATION_ID=LVNM3Z4RVRWDK
NEXT_PUBLIC_WEBFLOW_TOKEN=your_webflow_token_here
NEXT_PUBLIC_WEBFLOW_SITE_ID=6536f19431181574585ac1ce
NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID=68167d5a313e2fd6f18650c9
```

**CRITICAL:** Never commit `.env.local` to git. It's in `.gitignore`.

### Step 3: Deploy to Vercel

**Option A: Vercel CLI (Fastest)**
```bash
npm install -g vercel
vercel login
vercel
# Follow prompts, select your project name (e.g., "mounting-man-dashboard")
# Vercel will ask for environment variables - copy/paste from .env.local
```

**Option B: GitHub + Vercel Dashboard (Recommended)**
```bash
# Initialize git
git init
git add .
git commit -m "Initial commit: The Agency dashboard"

# Create repo on GitHub (https://github.com/new)
# Then push:
git remote add origin https://github.com/yourusername/mounting-man-dashboard.git
git push -u origin main

# Go to https://vercel.com/new
# Import your GitHub repo
# Add environment variables from .env.local
# Click Deploy
```

### Step 4: Access Your Dashboard

Your dashboard will be live at: `https://mounting-man-dashboard.vercel.app`

(Or whatever custom domain you assign)

---

## 🔄 How It Works

**Automatic Updates:**
- Dashboard refreshes data every 5 minutes automatically
- Shows real-time Square revenue data
- Shows live Webflow blog post counts
- Updates on page load

**Data Sources:**
- **Square API:** Pulls all completed payments, filters by month/day
- **Webflow API:** Counts published installation posts

---

## 📊 What You See

| Metric | Source | Updates |
|--------|--------|---------|
| All-Time Revenue | Square API | Every 5 min |
| This Month Revenue | Square API | Every 5 min |
| Today's Revenue | Square API | Every 5 min |
| Jobs Completed | Square API | Every 5 min |
| Avg Job Value | Calculated | Every 5 min |
| Blog Posts Live | Webflow API | Every 5 min |
| Draft Posts | Webflow API | Every 5 min |

---

## 🛠️ Local Development

Want to test/modify before deploying?

```bash
# Install dependencies
npm install

# Create .env.local (see Step 2 above)

# Run locally
npm run dev

# Open http://localhost:3000
```

Edit `components/Dashboard.js` to customize the UI. Changes hot-reload automatically.

---

## 🔐 Security Notes

1. **Never commit `.env.local`** - It's in `.gitignore`
2. **API tokens are environment variables** - Vercel keeps them private
3. **All API calls go through Next.js** - Your tokens never exposed to the browser
4. **Don't share `.env.local`** - It contains your live credentials

---

## 🚀 Scaling & Advanced Features

**Future enhancements:**
- Add more metrics (customer acquisition, cost per job, etc.)
- Real-time alerts when revenue milestones hit
- Historical revenue graphs (month-over-month)
- Geographic heat maps
- Campaign performance tracking
- Custom reports
- Slack/Telegram integration for alerts

---

## ❌ Troubleshooting

**"API connection failed" error?**
- Check `.env.local` has correct token values
- Verify tokens are from the right environments (Production, not Sandbox)
- Check Vercel environment variables match `.env.local`

**"Missing collection ID" error?**
- Verify `NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID` is correct
- Should be: `68167d5a313e2fd6f18650c9`

**Dashboard shows "Loading..." forever?**
- Check browser console (F12) for error messages
- Verify API tokens are valid
- Check Vercel logs: `vercel logs`

**Data looks old?**
- Dashboard auto-refreshes every 5 minutes
- Click refresh in browser to force immediate update
- Check "Last updated" timestamp

---

## 📞 Need Help?

1. Check the `.env.example` file for required variables
2. Review API documentation:
   - Square: https://developer.squareup.com/docs/payments-api/overview
   - Webflow: https://developers.webflow.com/
3. Check Vercel logs: `vercel logs --follow`

---

**Version:** 1.0  
**Status:** Production Ready  
**Last Updated:** February 2026
