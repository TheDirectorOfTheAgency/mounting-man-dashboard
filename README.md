# The Agency - Tactical Business Intelligence Dashboard

A spy-themed real-time dashboard for The Mounting Man that pulls live data from Square (revenue) and Webflow (blog content).

## ✨ Features

- **Real-time revenue tracking** from Square API
- **Blog post metrics** from Webflow API
- **Circular progress gauges** (monthly target, jobs completed, etc.)
- **7-day revenue trend chart**
- **Geographic distribution** visualization
- **Terminal/spy aesthetic** (black background, neon green text)
- **Auto-refresh** every 5 minutes
- **Responsive design** (desktop, tablet, mobile)

## 🚀 Quick Start

See `DEPLOYMENT.md` for complete setup instructions.

**TL;DR:**
```bash
# 1. Create .env.local with your API tokens
cp .env.example .env.local
# (fill in your Square + Webflow tokens)

# 2. Install and run locally
npm install
npm run dev

# 3. Deploy to Vercel
vercel
```

## 📁 Project Structure

```
mounting-man-dashboard/
├── pages/
│   ├── index.js              # Main dashboard page
│   ├── _app.js               # Next.js app wrapper
│   ├── _document.js          # HTML structure
│   └── api/
│       ├── square-revenue.js # Square API endpoint
│       └── webflow-posts.js  # Webflow API endpoint
├── components/
│   └── Dashboard.js          # Main dashboard component
├── styles/
│   └── globals.css           # Global styling + animations
├── .env.example              # Environment variable template
├── package.json              # Dependencies
├── tailwind.config.js        # Tailwind configuration
└── DEPLOYMENT.md             # Deployment guide
```

## 🔑 Environment Variables

Create `.env.local`:

```
NEXT_PUBLIC_SQUARE_ACCESS_TOKEN=your_token
NEXT_PUBLIC_SQUARE_LOCATION_ID=LVNM3Z4RVRWDK
NEXT_PUBLIC_WEBFLOW_TOKEN=your_token
NEXT_PUBLIC_WEBFLOW_SITE_ID=6536f19431181574585ac1ce
NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID=68167d5a313e2fd6f18650c9
```

## 🎨 Design

- **Color scheme:** Black (#0a0a0a) + Neon Green (#00ff00)
- **Font:** IBM Plex Mono (monospace/terminal aesthetic)
- **Layout:** CSS Grid responsive layout
- **Charts:** Recharts (lightweight, performant)

## 📊 Data Sources

### Square API
- All-time revenue (sum of completed payments)
- This month revenue (filtered to current month)
- Today's revenue (filtered to current day)
- Job count & average job value

### Webflow API
- Published installation blog posts
- Draft posts
- Total posts

## 🔄 Auto-Refresh

Dashboard automatically fetches new data every 5 minutes. No manual refresh needed. Last update timestamp shown at bottom.

## 🚢 Deployment

**Recommended:** Vercel (fastest, free tier sufficient)

```bash
vercel
```

See `DEPLOYMENT.md` for detailed instructions.

## 🛠️ Development

```bash
# Local development server
npm run dev
# Open http://localhost:3000

# Build for production
npm run build

# Start production server
npm start
```

## 📱 Browser Support

- Chrome/Chromium (best)
- Firefox
- Safari
- Edge

Mobile-responsive. Works on phones/tablets.

## 🔐 Security

- API tokens stored in Vercel environment variables (never exposed)
- All API calls go through Next.js backend
- `.env.local` in `.gitignore`
- No sensitive data in git history

## 🎯 Future Enhancements

- [ ] Customer acquisition costs
- [ ] Revenue forecasting
- [ ] Geographic heatmap
- [ ] Campaign performance
- [ ] Slack/email alerts
- [ ] Custom reports
- [ ] Historical data export

## 📞 Support

See `DEPLOYMENT.md` for troubleshooting.

---

**Version:** 1.0  
**Status:** Production Ready  
**Last Updated:** February 2026  
**Theme:** James Bond Tactical Intelligence
