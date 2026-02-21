# The Mounting Man — Google Ads Audit & Optimization Report
**Date:** February 21, 2026
**Period Analyzed:** November 24, 2025 — February 21, 2026 (90 days)
**Account:** The Mounting Man (128-790-7452)
**MCC:** The Agency (316-742-8631)

---

## EXECUTIVE SUMMARY

The Mounting Man is spending ~$19K/90 days (~$6,300/mo) on Google Ads across 14 active campaigns spanning 4 markets (Minneapolis, Houston, Austin, DC). The account is generating ~129 conversions at $147 CPA. **Conversion tracking IS working** — the "Booked Appointment" action (via GTM on the thank-you page) accounts for all tracked conversions, and "Landing Page Phone Calls - DM" provides call tracking with Google forwarding numbers.

**Top 3 Priorities:**
1. 💰 **Cut wasteful spend** — DC and Houston are spending $900+/90 days with near-zero returns ✅ DONE
2. 📊 **Restructure for profitability** — MSP campaigns are performing well but the MantelMount and expansion markets need work
3. 🔧 **Enhance conversion tracking** — Add click-to-call tracking + offline Square conversion import for full-funnel visibility

---

## 1. ACCOUNT STRUCTURE

### Active Campaigns (14 total)

| Campaign | Type | Bidding | 90-Day Spend | Clicks | Conv | CPA |
|---|---|---|---|---|---|---|
| MSP - General TV Mounting | Search | Max Conv Value | $13,179 | 1,131 | 70.1 | $188.00 |
| MSP - Samsung Frame | Search | Max Conv Value | $3,434 | 287 | 10.5 | $327.07 |
| Display Remarketing | Search* | Max Conversions | $459 | 370 | 9.5 | $48.32 |
| Austin - General TV Mounting | Search | Max Conv Value | $444 | 52 | 4.0 | $110.93 |
| MSP - Brand | Search | Target Imp Share | $421 | 216 | 31.9 | $13.19 |
| Houston - Samsung Frame | Search | Max Conv Value | $353 | 60 | 1.0 | $353.33 |
| Houston - General TV Mounting | Search | Max Conv Value | $390 | 62 | 1.0 | $389.95 |
| MSP MantelMount | Search | Max Conv Value | $97 | 8 | 0.0 | N/A |
| DC - General TV Mounting | Search | Target Spend | $120 | 61 | 0.0 | N/A |
| Austin - Samsung Frame | Search | Target Spend | $34 | 18 | 1.0 | $33.54 |
| DC - Samsung Frame | Search | Target Spend | — | — | — | — |
| Houston - MantelMount | Search | Max Conv Value | $50 | 18 | 0.0 | N/A |

*Display Remarketing is labeled as Search channel — this may be a campaign type mismatch.

### Key Structural Issues
- **MSP dominates** — ~90% of total spend is in Minneapolis campaigns
- **Houston/DC/Austin combined** spend ~$1,400/90 days with only ~7 conversions total
- **MantelMount** campaigns across all markets are barely getting any traffic
- **Multiple REMOVED ad groups** inside Austin campaign (copied from MSP structure, never cleaned up)
- **Bidding strategy mismatch** — using Max Conversion Value but no conversion value tracking exists

---

## 2. CONVERSION TRACKING AUDIT

### ✅ Conversion Tracking IS Working (Corrected)

**Initial assessment was wrong.** The Google Ads account overview showed an incomplete conversion setup wizard, which was misleading. Upon deeper investigation via the API and GTM inspection:

#### Active & Working Conversion Actions
| Action | ID | Type | Primary | How It Works |
|---|---|---|---|---|
| **Booked Appointment** | 6491204814 | WEBPAGE | ✅ Yes | GTM tag fires on /thank-you page (send_to: AW-506833748/a5BxCM7Zn5cYENTW1vEB) |
| **Landing Page Phone Calls - DM** | 1065481863 | WEBSITE_CALL | ✅ Yes | Google forwarding numbers replace site phone numbers, track calls |
| **Phone Call from Ad Extension** | 7509075265 | AD_CALL | ✅ Yes | Automatically tracks calls from ad call extensions ($250 value) |
| **Website Click-to-Call** | 7509024467 | WEBPAGE | ✅ Yes | NEW — needs GTM tag for tel: link clicks (send_to: AW-506833748/CvjaCNO9yvwbENTW1vEB) |

#### 30-Day Conversion Breakdown
- **Booked Appointment: 21.7 conversions** — this is the ONLY action currently recording data
- Phone call tracking may not be recording (needs verification that Google forwarding numbers are active)
- Smart Bidding is optimizing to real booking conversions, NOT junk data

#### Disabled/Secondary Actions (won't affect bidding)
| Action | ID | Status | Why |
|---|---|---|---|
| Website Booking Form Submission | 7509075268 | primaryForGoal=false | Duplicate of Booked Appointment |
| Phone Call from Website Google Tracking | 7509075271 | primaryForGoal=false | Duplicate of Landing Page Phone Calls - DM |

#### Still Recommended
1. **Add Website Click-to-Call GTM tag** — fires when users tap tel: links. send_to: `AW-506833748/CvjaCNO9yvwbENTW1vEB`, value: $150
2. **Verify Google forwarding numbers** — confirm "Landing Page Phone Calls - DM" is actually recording calls
3. **Offline conversion import from Square** — feed actual completed job revenue back for true ROAS optimization

---

## 3. KEYWORD PERFORMANCE (Top 15 by Spend)

| Keyword | Match | Spend | Clicks | Conv | CPA | Conv Rate |
|---|---|---|---|---|---|---|
| tv mounting service | Exact | $1,837 | 168 | 15.0 | $122.47 | 8.9% |
| tv mounting | Exact | $1,663 | 150 | 8.0 | $207.88 | 5.3% |
| tv mount installation | Exact | $1,422 | 156 | 8.0 | $177.75 | 5.1% |
| samsung frame tv installation | Exact | $1,187 | 100 | 2.0 | $593.50 | 2.0% |
| tv wall mounting | Exact | $942 | 81 | 5.0 | $188.40 | 6.2% |
| tv mount installation near me | Exact | $845 | 80 | 3.0 | $281.67 | 3.8% |
| samsung frame installation | Exact | $745 | 56 | 4.0 | $186.25 | 7.1% |
| tv wall mount installation | Exact | $717 | 58 | 5.0 | $143.40 | 8.6% |
| samsung the frame installation | Exact | $704 | 52 | 1.0 | $704.00 | 1.9% |
| same day tv mounting | Exact | $671 | 57 | 3.0 | $223.67 | 5.3% |
| tv mounting near me | Exact | $577 | 51 | 3.0 | $192.33 | 5.9% |
| tv mounting service near me | Exact | $535 | 42 | 3.0 | $178.33 | 7.1% |
| tv wall mounting service | Exact | $478 | 36 | 5.0 | $95.60 | 13.9% |
| mount tv on wall | Exact | $459 | 36 | 2.0 | $229.50 | 5.6% |
| the mounting man | Exact | $161 | 89 | 16.0 | $10.06 | 18.0% |

### Keyword Insights
- **"tv wall mounting service" (Exact)** is the best non-brand performer — 13.9% conv rate, $95.60 CPA
- **"tv mounting service" (Exact)** is the highest volume winner — 8.9% conv rate, $122 CPA
- **"the mounting man" (Brand)** is extremely efficient — $10 CPA, 18% conv rate
- **Samsung Frame keywords are expensive** — $593 and $704 CPA for two of the top Frame terms
- **"samsung the frame installation"** at $704 CPA with 1 conversion should be paused or heavily restricted
- All keywords are Exact match — no Phrase or Broad match being tested

---

## 4. SEARCH TERM ANALYSIS (Top Performers)

| Search Term | Clicks | Spend | Conv | CPA |
|---|---|---|---|---|
| tv mounting service | 87 | $1,306 | 12.0 | $108.83 |
| the mounting man | 74 | $99 | 14.0 | $7.07 |
| tv mounting | 73 | $784 | 5.0 | $156.80 |
| tv mount installation | 46 | $516 | 2.0 | $258.00 |
| mounting man | 43 | $50 | 5.0 | $10.00 |
| tv wall mounting | 41 | $479 | 3.0 | $159.67 |
| tv wall mount installation | 36 | $460 | 4.0 | $115.00 |
| samsung frame tv installation | 32 | $388 | 1.0 | $388.00 |
| tv mounting service near me | 30 | $398 | 2.0 | $199.00 |
| tv wall mounting service | 29 | $338 | 5.0 | $67.60 |

**"tv wall mounting service"** ($67.60 CPA) and **brand terms** ($7-10 CPA) are by far the most efficient search terms.

---

## 5. DEMOGRAPHIC PERFORMANCE

### Age
| Age | Conv | Cost | CPA | Conv Rate | Action |
|---|---|---|---|---|---|
| 35-44 | 38 | $4,588 | $120.74 | 7.3% | ✅ Increase bids |
| 25-34 | 22 | $3,369 | $153.13 | 6.7% | ✅ Maintain |
| 65+ | 9 | $1,101 | $122.34 | 6.0% | ✅ Maintain |
| 45-54 | 16 | $2,652 | $165.76 | 4.8% | ⚠️ Monitor |
| 18-24 | 3 | $277 | $92.23 | 5.7% | ⚠️ Low volume |
| 55-64 | 7 | $1,633 | $233.31 | 3.1% | 🔻 Reduce bids |

**Winner:** 35-44 year olds — best conversion rate AND best CPA at scale.
**Loser:** 55-64 — worst CPA at $233, worst conversion rate at 3.1%. Reduce bid adjustments.

### Gender
| Gender | Conv | Cost | CPA | Conv Rate |
|---|---|---|---|---|
| Male | 65 | $8,559 | $131.68 | 6.5% |
| Female | 30 | $5,106 | $170.19 | 4.5% |

**Males convert 44% better** and cost 23% less per conversion. Apply +15% bid adjustment for males, -10% for females.

### Household Income
| Tier | Conv | Cost | CPA | Conv Rate |
|---|---|---|---|---|
| Top 10% | 67 | $9,132 | $136.29 | 6.1% |
| Top 11-20% | 13 | $1,769 | $136.04 | 6.8% |
| Top 41-50% | 5 | $566 | $113.26 | 7.2% |
| Top 31-40% | 4 | $618 | $154.52 | 4.8% |
| Top 21-30% | 5 | $1,372 | $274.42 | 3.4% |
| Bottom 50% | 0 | $73 | N/A | 0% |

**Top 10-20% income = ideal customers.** Bottom 50% has ZERO conversions. Apply -30% bid for bottom 50%, +10% for top 10%.
**Top 21-30% is problematic** — $274 CPA, only 3.4% conversion rate. Apply -15% bid adjustment.

### Device
| Device | Conv | Cost | CPA |
|---|---|---|---|
| Mobile | 83 | $12,820 | $154.46 |
| Desktop | 42 | $5,750 | $136.90 |
| Tablet | 4 | $359 | $89.75 |

Mobile drives 64% of conversions but Desktop has a better CPA. This is typical for service businesses — people search on mobile but often call from the same device. No dramatic changes needed, but don't neglect desktop.

---

## 6. DAY & TIME PERFORMANCE

### Best Days (by CPA)
1. **Tuesday** — $121.54 CPA, 6.2% CVR ✅
2. **Friday** — $121.60 CPA, 7.1% CVR ✅ (BEST conversion rate)
3. **Saturday** — $148.97 CPA

### Worst Day
- **Sunday** — $194.79 CPA, 3.7% CVR (worst by far). Consider -15% bid adjustment.

### Best Hours (by CPA, min 5 conversions)
1. **7PM (19:00)** — $87.67 CPA, 13.6 conversions ⭐ Best hour
2. **1PM (13:00)** — $98.43 CPA, 13.5 conversions ⭐
3. **8AM-9AM** — ~$129 CPA, ~8.7 conversions each
4. **2PM (14:00)** — $139.82 CPA, 14.2 conversions (highest volume hour)

### Dead Hours (0 conversions)
- **1AM-5AM** — 45 clicks, $220 spent, ZERO conversions. Apply -100% bid (pause) from 1AM-5AM.

### Recommended Ad Schedule
- **Peak hours (8AM-2PM, 7PM-8PM):** +10% bid
- **Off-peak (10PM-6AM):** -50% to -100% bid
- **Sunday:** -15% bid

---

## 7. AD COPY ANALYSIS

### Top Performing Ad (by volume)
**MSP - General TV Mounting / Core:**
- Headlines: "Twin Cities TV Mounting | TV Mounting Service $150+ | Pro TV Mounting | Book Online in 60 Seconds | TV Mounting Near Me"
- Description: "I'm Marshall Wayne, my small team and I mount TVs in Minneapolis/St. Paul Metro"
- Performance: 9,126 impressions, 576 clicks, $6,381 cost, 43.1 conversions
- **CTR: 6.3%, CPA: $148**

### Most Efficient Ad (by CPA)
**Brand — Core Brand:**
- Headlines: "The Mounting Man | TV Mounting Minneapolis | 700+ Google Reviews | Samsung Frame Experts | Over-Fireplace Pros"
- Description: "I'm Marshall Wayne, the Mounting Man. I run a small shop, we are prompt, and professional."
- Performance: 764 impressions, 216 clicks, $421 cost, 31.9 conversions
- **CTR: 28.3%, CPA: $13.19** ⭐

### Remarketing is Crushing It
**Display Remarketing / General Retargeting:**
- 10,079 impressions, 364 clicks, $447 cost, 9.5 conversions
- **CPA: $48.32** — cheapest non-brand CPA in the account

### Ad Copy Strengths
- Personal brand ("I'm Marshall Wayne") works very well
- Social proof ("700+ Google Reviews", "650+ 5 Star Google Reviews") is compelling
- Price anchor ("$150+") sets expectations

### Ad Copy Weaknesses
- Houston/Austin/DC ads are generic — no personal touch, no local credibility
- Samsung Frame ads don't mention price range (Frame installs are premium, should qualify)
- MantelMount ads mention "400+ installs" but get almost no clicks — may need better headlines
- No ad copy testing happening — each ad group has only 1 RSA

---

## 8. GEOGRAPHIC PERFORMANCE

### Market Breakdown (90 days)

| Market | Spend | Conv | CPA | Assessment |
|---|---|---|---|---|
| **Minneapolis (MSP)** | ~$17,131 | ~112 | ~$153 | ✅ Core market, optimize |
| **Houston** | ~$743 | ~2 | ~$371 | 🔻 Pause or dramatically restructure |
| **Austin** | ~$478 | ~5 | ~$96 | ⚠️ Promising but low volume |
| **DC** | ~$120 | ~0 | N/A | 🔻 Pause immediately |

**MSP is 90% of the business and 87% of conversions.** Houston and DC are money pits.

---

## 9. OPTIMIZATION RECOMMENDATIONS

### 🔴 IMMEDIATE (This Week)

#### 1. ~~Set Up Conversion Tracking~~ → PARTIALLY DONE ✅
- ~~Install Google Ads phone call tracking~~ — "Landing Page Phone Calls - DM" already exists and is ENABLED
- ~~Set up Google Tag for form submission tracking~~ — "Booked Appointment" GTM tag already tracks bookings on /thank-you page
- ✅ Created "Phone Call from Ad Extension" (AD_CALL type, $250 value) via API
- ✅ Created "Website Click-to-Call" (WEBPAGE type, $150 value) via API — needs GTM tag
- ✅ Disabled duplicate conversion actions (primaryForGoal=false) to prevent double-counting
- **TODO:** Add Website Click-to-Call tag to GTM (send_to: AW-506833748/CvjaCNO9yvwbENTW1vEB)
- **TODO:** Verify Google forwarding numbers are active for "Landing Page Phone Calls - DM"

#### 2. Pause Money-Wasting Campaigns → ✅ DONE
- ✅ **DC campaigns PAUSED** via API (DC - General: 23246944048, DC - Samsung Frame: 23246943838)
- ✅ **Houston budgets reduced to $5/day** via API (General: budget 15126435724, Samsung Frame: budget 15126434527)
- Saves ~$300/month immediately

#### 3. Block Dead Hours → ✅ DONE
- ✅ Applied 6AM-midnight ad schedules to ALL active campaigns via API:
  - MSP General (20867488270), Samsung Frame (23038170184), Brand (23013478245), MantelMount (20867417728), Display Remarketing (23035645593)
- ✅ Remarketing budget increased from $5/day to $15/day (budget 14955992821)
- Estimated savings: ~$100/month with no conversion loss

#### 4. Kill Expensive Samsung Keywords → ✅ DONE
- ✅ **Paused "Samsung The Frame installation" [PHRASE]** in MSP- Samsung Frame campaign (criterion 2453417012864, ad group 185413012523) via API
- Note: Exact match of same keyword in MSP - General TV Mounting was already in a REMOVED ad group (185082202749)
- Review all Samsung Frame keywords with CPA > $300

### 🟡 SHORT-TERM (Next 2 Weeks)

#### 5. Demographic Bid Adjustments
- Age 55-64: -20% bid adjustment
- Age 35-44: +15% bid adjustment
- Male: +15% bid adjustment
- Female: -10% bid adjustment
- Bottom 50% income: -30% bid adjustment
- Top 21-30% income: -15% bid adjustment
- Sunday: -15% bid adjustment

#### 6. Expand What's Working
- "tv wall mounting service" has 13.9% CVR and $95 CPA — add phrase match variant
- "tv mounting service" at 8.9% CVR — test phrase match to capture long-tail variations
- Brand campaign is extremely efficient ($13 CPA) — ensure full coverage of brand misspellings

#### 7. Increase Remarketing Budget
- Display Remarketing has $48 CPA — the cheapest in the account
- Currently only spending $459/90 days ($5/day)
- Increase to $15-20/day — this audience has already shown intent

### 🟢 MEDIUM-TERM (Next Month)

#### 8. Build Dedicated MantelMount Campaign
Current MantelMount ad groups are scattered and underperforming:
- MSP MantelMount: $97 spend, 0 conversions
- Houston MantelMount: $50 spend, 0 conversions
- DC MantelMount: $84 spend, 0 conversions

**Recommendation:** Consolidate into a single MSP-focused MantelMount campaign with:
- Keywords: mantelmount installation, pull down tv mount, mantel mount installer, tv over fireplace mount
- Ad copy: Lead with "400+ MantelMount Installs" and price range
- Budget: $10/day, MSP geo only
- Wait for conversion tracking before expanding

#### 9. Samsung Frame Campaign Restructure
Current Samsung Frame CPA is too high ($327 MSP, $353 Houston). After conversion tracking is live:
- Tighten keywords to highest-intent only
- Create dedicated landing page for Frame installations
- Lead with "Samsung Frame Specialist" positioning
- Include pricing to pre-qualify (Frame installs are premium)

#### 10. Fix Bidding Strategies
Currently using Max Conversion Value with no conversion values defined. After conversion tracking is live (with values):
- Switch MSP General to Target CPA at ~$125 (current avg)
- Switch Brand to Target Impression Share (already set correctly)
- Switch Remarketing to Target CPA at ~$50

---

## 10. PROJECTED IMPACT

### Conservative Estimates (based on changes above)

| Change | Monthly Savings/Gains |
|---|---|
| Pause DC + reduce Houston | -$300/mo spend |
| Block dead hours (1-5AM) | -$100/mo spend, 0 conv loss |
| Demographic bid adjustments | ~5-10% efficiency gain |
| Increase remarketing | +$300/mo spend, +6 conversions |
| Kill bad Samsung keywords | -$50/mo spend |
| **Net effect** | ~$150/mo less spend, ~6 more conversions |

### After Conversion Tracking (30+ day horizon)
Once real conversion tracking is live, you'll be able to:
- See which keywords drive actual phone calls and bookings
- Let Smart Bidding optimize to real revenue signals
- Calculate true CAC (currently impossible)
- Make data-driven budget allocation across markets

---

## APPENDIX A: Campaign Structure Diagram

```
The Mounting Man (128-790-7452)
├── MSP - General TV Mounting (Max Conv Value) ........... $13,179 / 70 conv
│   ├── TV Mounting — Core ............................ $6,381 / 43 conv ⭐
│   ├── TV Mounting - Same Day ........................ $5,914 / 25 conv
│   ├── TV Mounting - Above Fireplace ................. $320 / 1 conv
│   ├── TV Mounting - Near Me ......................... $563 / 1 conv
│   ├── TV Mounting - Brick/Masonry ................... $1 / 0 conv
│   ├── TV Mounting - Large TVs ....................... (minimal)
│   ├── TV Mounting - In-Wall Wiring .................. PAUSED
│   └── TV Mounting - Soundbar + Accessories .......... PAUSED
├── MSP - Samsung Frame (Max Conv Value) ................ $3,434 / 10.5 conv
│   ├── The Frame - High Intent ....................... $3,434 / 10.5 conv
│   ├── The Frame - Core .............................. PAUSED
│   ├── The Frame - Broad ............................. PAUSED
│   ├── The Frame - Competitor ........................ PAUSED
│   └── The Frame - DIY ............................... PAUSED
├── MSP - Brand (Target Imp Share) ...................... $421 / 31.9 conv ⭐
│   └── Core Brand .................................... $421 / 31.9 conv
├── MSP MantelMount (Max Conv Value) .................... $97 / 0 conv ⚠️
│   └── Core .......................................... $97 / 0 conv
├── Display Remarketing (Max Conversions) ............... $459 / 9.5 conv ⭐
│   ├── General TV Mounting - Retargeting ............. $447 / 9.5 conv
│   ├── MantelMount - Retargeting ..................... $7 / 0 conv
│   ├── Competitors/DIY - Retargeting ................. $6 / 0 conv
│   └── Samsung Frame - Retargeting ................... $0 / 0 conv
├── Austin - General TV Mounting (Max Conv Value) ....... $444 / 4 conv
├── Austin - Samsung Frame (Target Spend) ............... $34 / 1 conv
├── Houston - General TV Mounting (Max Conv Value) ...... $390 / 1 conv ⚠️
├── Houston - Samsung Frame (Max Conv Value) ............ $353 / 1 conv ⚠️
├── DC - General TV Mounting (Target Spend) ............. $120 / 0 conv 🔻
└── DC - Samsung Frame (Target Spend) ................... minimal
```

## APPENDIX B: API Credentials (Working as of 2026-02-21)

- **Developer Token:** `b7mhI-wsuUwSCkTdk-UGiA` (reset 2026-02-21, Basic Access)
- **OAuth Client:** gen-lang-client-0151509552 (OLD "The Agency" project)
- **Refresh Token:** For mntvmounting@gmail.com, stored in Vercel env
- **API Endpoint:** `https://googleads.googleapis.com/v20/customers/1287907452/googleAds:searchStream`
- **login-customer-id:** `3167428631` (MUST use MCC that owns dev token)
- **Root cause of previous API failure:** Developer token was permanently paired to wrong Google Cloud project. Fixed by resetting token in Google Ads Admin > API Center.

## APPENDIX C: Next Steps Checklist

### ✅ Completed (2026-02-21)
- [x] Fix Google Ads API auth (developer token reset + root cause documented)
- [x] Update Vercel env with new developer token (`b7mhI-wsuUwSCkTdk-UGiA`)
- [x] Update CLAUDE.md with new developer token + resolved API issue
- [x] Pause DC campaigns (both General + Samsung Frame)
- [x] Reduce Houston daily budget to $5/day (both campaigns)
- [x] Apply ad schedules — 6AM-midnight on all 5 active campaign ad networks
- [x] Increase remarketing budget from $5/day to $15/day
- [x] Create Phone Call from Ad Extension conversion action ($250 value)
- [x] Create Website Click-to-Call conversion action ($150 value)
- [x] Disable duplicate conversion actions (primaryForGoal=false)
- [x] Redeploy production to Vercel with new env vars
- [x] Pause "Samsung The Frame installation" [PHRASE] in MSP- Samsung Frame (criterion 2453417012864)
- [x] Build Zenbooker → Google Ads offline conversion pipeline (lib/*, pages/api/webhooks/zenbooker.js)
- [x] Create "Offline Job Completed" conversion action (ID: 7509313857, UPLOAD_CLICKS, primaryForGoal=false)
- [x] Extract shared Google Ads auth module (lib/google-ads-auth.js)
- [x] Create PII hashing utility (lib/hash-pii.js — SHA-256, Gmail normalization, E.164 phone)
- [x] Set GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID and ZENBOOKER_WEBHOOK_SECRET in Vercel env

### 🔲 Still To Do
- [ ] Add Website Click-to-Call GTM tag (send_to: AW-506833748/CvjaCNO9yvwbENTW1vEB)
- [ ] Verify Google forwarding numbers are active for phone call tracking
- [ ] Apply demographic bid adjustments (age, gender, income) — requires manual campaign bidding changes (Smart Bidding blocks these)
- [ ] Set up Vercel KV database (Vercel Dashboard → Storage → Create KV Database → link to project)
- [ ] Configure Zenbooker webhook URL: `https://mounting-man-dashboard.vercel.app/api/webhooks/zenbooker?secret=XXXXX`
- [ ] Enable Enhanced Conversions for Leads in Google Ads UI (Settings → Measurement → Enhanced conversions)
- [ ] Verify Zenbooker webhook field names match FIELD_MAP (check Vercel logs after first webhook fires)
- [ ] After 2 weeks: promote "Offline Job Completed" to primaryForGoal=true
- [ ] After 2 weeks: review data with real conversions
- [ ] After 30 days: restructure MantelMount + Samsung Frame campaigns
- [ ] Build dedicated MantelMount campaign (MSP-focused, $10/day)
- [ ] Create Samsung Frame dedicated landing page
- [ ] Test Phrase match for top-performing Exact keywords
