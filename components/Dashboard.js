import React, { useState, useEffect, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';

// ─── HUD GAUGE ─────────────────────────────────────────────
const HudGauge = ({ value, max, label, size = 120, code = '', displayValue }) => {
  const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const r = (size - 16) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (percentage / 100) * circumference;
  // Show the actual value (or a custom displayValue) instead of percentage
  const shown = displayValue !== undefined ? displayValue : (typeof value === 'number' ? value.toLocaleString() : value);

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="gauge-ring">
          {/* Tick marks */}
          {Array.from({ length: 24 }).map((_, i) => {
            const angle = (i / 24) * 360 - 90;
            const rad = (angle * Math.PI) / 180;
            const x1 = cx + (r + 4) * Math.cos(rad);
            const y1 = cy + (r + 4) * Math.sin(rad);
            const x2 = cx + (r + (i % 6 === 0 ? 8 : 6)) * Math.cos(rad);
            const y2 = cy + (r + (i % 6 === 0 ? 8 : 6)) * Math.sin(rad);
            return (
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={i % 6 === 0 ? '#4a4d51' : '#2a2d31'} strokeWidth="1" />
            );
          })}
          {/* Background ring */}
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1e2025" strokeWidth="3" />
          {/* Progress ring */}
          <circle cx={cx} cy={cy} r={r} fill="none"
            stroke="#c8e632" strokeWidth="3"
            strokeDasharray={circumference} strokeDashoffset={offset}
            strokeLinecap="butt"
            transform={`rotate(-90 ${cx} ${cy})`}
            style={{ transition: 'stroke-dashoffset 1s ease' }} />
          {/* Inner dim ring */}
          <circle cx={cx} cy={cy} r={r - 10} fill="none" stroke="#1a1d21" strokeWidth="1" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-hud-green glow-text" style={{ fontFamily: 'Orbitron, monospace' }}>
            {shown}
          </span>
          <span className="text-[9px] text-hud-text-dim tracking-widest uppercase">
            {code || 'pt'}
          </span>
        </div>
      </div>
      <span className="text-[9px] text-hud-text tracking-[2px] uppercase">{label}</span>
    </div>
  );
};

// ─── STATUS INDICATOR ──────────────────────────────────────
const StatusDot = ({ active = true, label }) => (
  <div className="flex items-center gap-2">
    <div className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-hud-green' : 'bg-hud-red'}`}
      style={active ? { boxShadow: '0 0 6px rgba(200,230,50,0.6)' } : {}} />
    <span className="text-[10px] text-hud-text tracking-wider uppercase">{label}</span>
  </div>
);

// ─── HUD DATA ROW ──────────────────────────────────────────
const DataRow = ({ label, value, code, highlight = false }) => (
  <div className="flex items-center justify-between py-2 border-b border-hud-border/30">
    <div className="flex items-center gap-3">
      {code && (
        <span className="text-[9px] text-hud-text-dim font-mono tracking-wider w-8">{code}</span>
      )}
      <span className="text-[10px] text-hud-text tracking-wider uppercase">{label}</span>
    </div>
    <span className={`text-sm font-mono font-bold ${highlight ? 'text-hud-green glow-text' : 'text-hud-white'}`}>
      {value}
    </span>
  </div>
);

// ─── TRACKING BAR ──────────────────────────────────────────
const TrackingBar = ({ label, value, max, color = 'hud-green' }) => {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <span className="text-[9px] text-hud-text-dim tracking-[2px] uppercase">{label}</span>
        <span className="text-[9px] text-hud-text-dim">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 bg-hud-border/50 relative overflow-hidden">
        <div className={`h-full data-bar`}
          style={{
            width: `${pct}%`,
            background: color === 'hud-green'
              ? 'linear-gradient(90deg, #8fa623, #c8e632)'
              : 'linear-gradient(90deg, #e63232, #ff5555)',
            transition: 'width 1s ease',
          }} />
      </div>
    </div>
  );
};

// ─── NODE BLOCK ────────────────────────────────────────────
const NodeBlock = ({ label, active = false, color = 'green' }) => (
  <div className={`px-3 py-2 text-[9px] font-mono tracking-wider uppercase text-center border
    ${active
      ? 'bg-hud-green/20 border-hud-green/40 text-hud-green'
      : 'bg-hud-panel border-hud-border text-hud-text-dim'
    }`}>
    {label}
  </div>
);

// ─── MAIN DASHBOARD ────────────────────────────────────────
export default function Dashboard() {
  const [squareData, setSquareData] = useState(null);
  const [webflowData, setWebflowData] = useState(null);
  const [adsData, setAdsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [revenueHistory, setRevenueHistory] = useState([]);
  const [time, setTime] = useState(new Date());

  // Clock
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Fetch data
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [squareRes, webflowRes, adsRes] = await Promise.all([
          fetch('/api/square-revenue'),
          fetch('/api/webflow-posts'),
          fetch('/api/google-ads'),
        ]);

        const squareJson = squareRes.ok ? await squareRes.json() : null;
        const webflowJson = webflowRes.ok ? await webflowRes.json() : null;
        const adsJson = adsRes.ok ? await adsRes.json() : null;

        if (squareJson && !squareJson.error) {
          setSquareData(squareJson);
          const dailyTarget = Math.round(32000 / 30);
          if (squareJson.revenueHistory && squareJson.revenueHistory.length > 0) {
            setRevenueHistory(squareJson.revenueHistory.map(d => ({ ...d, target: dailyTarget })));
          }
        }
        if (webflowJson && !webflowJson.error) setWebflowData(webflowJson);
        if (adsJson && !adsJson.error) setAdsData(adsJson);
        setLastUpdated(new Date());
        setError(null);
      } catch (err) {
        console.error('Error fetching data:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !squareData) {
    return (
      <div className="min-h-screen bg-hud-black hud-grid flex items-center justify-center">
        <div className="text-center animate-flicker">
          <div className="text-hud-green text-lg glow-text" style={{ fontFamily: 'Orbitron, monospace', letterSpacing: '6px' }}>
            INITIALIZING SYSTEMS
          </div>
          <div className="text-[10px] text-hud-text-dim mt-3 tracking-[4px]">CONNECTING TO DATA SOURCES</div>
          <div className="mt-6 w-48 h-0.5 bg-hud-border mx-auto overflow-hidden">
            <div className="h-full bg-hud-green animate-data-flow" style={{ width: '30%' }} />
          </div>
        </div>
      </div>
    );
  }

  const monthlyTarget = 32000;
  const monthlyProgress = squareData?.thisMonth?.total || 0;
  const monthlyPct = (monthlyProgress / monthlyTarget) * 100;
  const jobsTarget = 20;
  const jobsCompleted = squareData?.thisMonth?.count || 0;
  const jobsPct = (jobsCompleted / jobsTarget) * 100;
  const allTimeRevenue = squareData?.allTime?.total || 0;
  const allTimeJobs = squareData?.allTime?.count || 0;
  const avgJob = squareData?.allTime?.avgValue || 0;
  const todayRevenue = squareData?.today?.total || 0;

  return (
    <div className="min-h-screen bg-hud-black hud-grid text-hud-white font-terminal relative">
      {/* Noise overlay */}
      <div className="noise-overlay" />

      {/* Scan line */}
      <div className="hud-scanline fixed inset-0 pointer-events-none z-50" />

      <div className="relative z-10 p-4 lg:p-6 max-w-[1600px] mx-auto">

        {/* ═══ TOP HEADER BAR ═══ */}
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-hud-border/50">
          <div className="flex items-center gap-6">
            <div>
              <h1 className="text-xl font-bold text-hud-green glow-text-strong tracking-[4px]"
                style={{ fontFamily: 'Orbitron, monospace' }}>
                THE AGENCY
              </h1>
              <div className="text-[9px] text-hud-text-dim tracking-[3px] mt-0.5">
                TACTICAL BUSINESS INTELLIGENCE
              </div>
            </div>
            <div className="hidden md:flex items-center gap-1 text-[9px] text-hud-text-dim">
              <span className="px-2 py-0.5 border border-hud-border text-hud-text tracking-wider">FX-D</span>
              <span className="px-2 py-0.5 border border-hud-border text-hud-text tracking-wider">TREAD FEED</span>
              <span className="px-2 py-0.5 border border-hud-green/30 text-hud-green tracking-wider bg-hud-green/5">LIVE</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg text-hud-green font-mono glow-text" style={{ fontFamily: 'Orbitron, monospace' }}>
              {time.toLocaleTimeString('en-US', { hour12: false })}
            </div>
            <div className="text-[9px] text-hud-text-dim tracking-wider">
              {time.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()}
              {error && <span className="text-hud-red ml-3">SYS ERROR</span>}
            </div>
          </div>
        </div>

        {/* ═══ GAUGE ROW ═══ */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
          {/* Gauges */}
          <div className="hud-panel p-4 flex justify-center">
            <HudGauge value={monthlyProgress} max={monthlyTarget} label="MONTHLY TARGET" size={110} code="$" displayValue={`${monthlyPct.toFixed(0)}%`} />
          </div>
          <div className="hud-panel p-4 flex justify-center">
            <HudGauge value={jobsCompleted} max={jobsTarget} label="JOBS THIS MONTH" size={110} code="JBS" displayValue={jobsCompleted} />
          </div>

          {/* Key Metrics */}
          <div className="hud-panel p-4 hud-bracket">
            <div className="hud-panel-header mb-3">ALL-TIME REV</div>
            <div className="text-2xl font-bold text-hud-green glow-text font-mono">
              ${allTimeRevenue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </div>
            <div className="text-[9px] text-hud-text-dim mt-1 tracking-wider">{allTimeJobs} COMPLETED JOBS</div>
          </div>
          <div className="hud-panel p-4 hud-bracket">
            <div className="hud-panel-header mb-3">THIS MONTH</div>
            <div className="text-2xl font-bold text-hud-green glow-text font-mono">
              ${monthlyProgress.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </div>
            <div className="text-[9px] text-hud-text-dim mt-1 tracking-wider">
              {monthlyPct.toFixed(0)}% OF ${monthlyTarget.toLocaleString()} TARGET
            </div>
          </div>
          <div className="hud-panel p-4 hud-bracket">
            <div className="hud-panel-header mb-3">TODAY</div>
            <div className="text-2xl font-bold text-hud-green glow-text font-mono">
              ${todayRevenue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </div>
            <div className="text-[9px] text-hud-text-dim mt-1 tracking-wider">
              AVG JOB: ${avgJob.toFixed(0)}
            </div>
          </div>
          <div className="hud-panel p-4 flex justify-center">
            <HudGauge value={adsData?.thisWeekSpend || 0} max={1000} label="WEEKLY AD SPEND" size={110} code="ADS"
              displayValue={`$${(adsData?.thisWeekSpend || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`} />
          </div>
        </div>

        {/* ═══ TRACKING DATA BARS ═══ */}
        <div className="hud-panel p-4 mb-6">
          <div className="hud-panel-header mb-4">TRACKING DATA</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
            <TrackingBar label="MONTHLY REVENUE" value={monthlyProgress} max={monthlyTarget} />
            <TrackingBar label="JOB COMPLETION" value={jobsCompleted} max={jobsTarget} />
            <TrackingBar label="CONTENT PIPELINE" value={webflowData?.published || 0} max={(webflowData?.total || 1)} />
            <TrackingBar label="GEOGRAPHIC COVERAGE" value={3} max={5} />
          </div>
        </div>

        {/* ═══ MAIN CONTENT GRID ═══ */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">

          {/* Revenue Chart - spans 2 cols */}
          <div className="lg:col-span-2 hud-panel p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="hud-panel-header">REVENUE TREND // 7 DAYS</div>
              <div className="flex items-center gap-4 text-[9px]">
                <span className="flex items-center gap-1">
                  <span className="w-3 h-0.5 bg-hud-green inline-block" /> REVENUE
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-0.5 bg-hud-border-light inline-block" /> TARGET
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={revenueHistory}>
                <defs>
                  <linearGradient id="greenGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#c8e632" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#c8e632" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 6" stroke="#1e2025" vertical={false} />
                <XAxis dataKey="date" stroke="#4a4d51" tick={{ fontSize: 9, letterSpacing: '2px' }} axisLine={false} tickLine={false} />
                <YAxis stroke="#4a4d51" tick={{ fontSize: 9 }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`} />
                <Tooltip
                  contentStyle={{
                    background: '#131619',
                    border: '1px solid #2a2d31',
                    borderRadius: 0,
                    fontSize: '11px',
                    fontFamily: 'IBM Plex Mono',
                  }}
                  labelStyle={{ color: '#8a8d91' }}
                  itemStyle={{ color: '#c8e632' }}
                  formatter={(v) => [`$${v.toLocaleString()}`, '']}
                />
                <Line type="monotone" dataKey="target" stroke="#2a2d31" strokeWidth={1} strokeDasharray="4 4" dot={false} />
                <Area type="monotone" dataKey="revenue" stroke="#c8e632" strokeWidth={2} fill="url(#greenGrad)"
                  dot={{ fill: '#c8e632', r: 3, stroke: '#0a0a0a', strokeWidth: 2 }}
                  activeDot={{ r: 5, stroke: '#c8e632', strokeWidth: 2, fill: '#0a0a0a' }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Signal Panel */}
          <div className="hud-panel p-4">
            <div className="hud-panel-header mb-4">SIGNAL METRICS</div>
            <DataRow code="AMP" label="All-Time Revenue" value={`$${allTimeRevenue.toLocaleString()}`} highlight />
            <DataRow code="FRQ" label="Monthly Revenue" value={`$${monthlyProgress.toLocaleString()}`} highlight />
            <DataRow code="PHS" label="Today Revenue" value={`$${todayRevenue.toLocaleString()}`} highlight />
            <DataRow code="R9" label="Total Jobs" value={allTimeJobs} />
            <DataRow code="R2" label="Avg Job Value" value={`$${avgJob.toFixed(0)}`} />
            <DataRow code="G7" label="Monthly Jobs" value={jobsCompleted} />
            <DataRow code="D6" label="Monthly Target" value={`$${monthlyTarget.toLocaleString()}`} />
            <DataRow code="AD1" label="All-Time Ad Spend" value={`$${(adsData?.allTimeSpend || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`} />
            <DataRow code="AD2" label="Monthly Ad Spend" value={`$${(adsData?.thisMonthSpend || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`} />
            <DataRow code="AD3" label="Weekly Ad Spend" value={`$${(adsData?.thisWeekSpend || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`} />
            <DataRow code="ROI" label="Net Revenue (All-Time)" value={`$${(allTimeRevenue - (adsData?.allTimeSpend || 0)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`} highlight />
          </div>
        </div>

        {/* ═══ BOTTOM GRID ═══ */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">

          {/* Content Pipeline */}
          <div className="hud-panel p-4">
            <div className="hud-panel-header mb-4">CONTENT PIPELINE</div>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-hud-text tracking-wider">BLOG POSTS LIVE</span>
                <span className="text-lg font-bold text-hud-green glow-text font-mono">{webflowData?.published || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-hud-text tracking-wider">DRAFT POSTS</span>
                <span className="text-lg font-bold text-hud-white font-mono">{webflowData?.draft || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-hud-text tracking-wider">SOCIAL READY</span>
                <span className="text-lg font-bold text-hud-green glow-text font-mono">3</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-hud-text tracking-wider">TOTAL CONTENT</span>
                <span className="text-lg font-bold text-hud-white font-mono">{webflowData?.total || 0}</span>
              </div>
            </div>
          </div>

          {/* Geographic Distribution */}
          <div className="hud-panel p-4">
            <div className="hud-panel-header mb-4">GEOGRAPHIC DISTRIBUTION</div>
            <div className="space-y-4">
              {[
                { city: 'Minneapolis', code: 'MSP', pct: 81 },
                { city: 'Houston', code: 'HOU', pct: 12 },
                { city: 'Austin', code: 'AUS', pct: 7 },
              ].map(({ city, code, pct }) => (
                <div key={code}>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[10px] text-hud-text tracking-wider">{city} ({code})</span>
                    <span className="text-xs text-hud-green font-mono glow-text">{pct}%</span>
                  </div>
                  <div className="h-1 bg-hud-border/50 overflow-hidden">
                    <div className="h-full data-bar"
                      style={{
                        width: `${pct}%`,
                        background: 'linear-gradient(90deg, #8fa623, #c8e632)',
                        transition: 'width 1s ease',
                      }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* System Nodes */}
          <div className="hud-panel p-4">
            <div className="hud-panel-header mb-4">SYSTEM NODES</div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <NodeBlock label="SQUARE" active />
              <NodeBlock label="WEBFLOW" active />
              <NodeBlock label="GOOGLE ADS" active />
            </div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <NodeBlock label="CRM" />
              <NodeBlock label="SOCIAL" />
              <NodeBlock label="ANALYTICS" />
            </div>
            <div className="mt-4 space-y-2">
              <StatusDot active label="SQUARE API CONNECTED" />
              <StatusDot active={!!webflowData} label="WEBFLOW API CONNECTED" />
              <StatusDot active={!!adsData} label="GOOGLE ADS CONNECTED" />
              <StatusDot active={!error} label="ALL SYSTEMS OPERATIONAL" />
            </div>
          </div>
        </div>

        {/* ═══ FOOTER STATUS BAR ═══ */}
        <div className="border-t border-hud-border/30 pt-3 flex flex-col sm:flex-row justify-between items-center gap-2">
          <div className="flex items-center gap-4 text-[9px] text-hud-text-dim tracking-wider">
            <span>SEC F-pLN</span>
            <span className="text-hud-green">DASHBOARD v2.0</span>
            <span>LAST SYNC: {lastUpdated.toLocaleTimeString('en-US', { hour12: false })}</span>
          </div>
          <div className="flex items-center gap-4 text-[9px] text-hud-text-dim tracking-wider">
            <span>NAV/S-P6.3</span>
            <span>BPS ES H-4</span>
            <span className="text-hud-green animate-pulse-green">STREAM ACTIVE</span>
          </div>
        </div>
      </div>
    </div>
  );
}
