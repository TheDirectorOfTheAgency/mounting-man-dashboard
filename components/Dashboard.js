// components/Dashboard.js
import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';

const GaugeCircle = ({ value, max, label, unit = '' }) => {
  const percentage = (value / max) * 100;
  const circumference = 2 * Math.PI * 45;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <div className="flex flex-col items-center">
      <svg width="140" height="140" className="transform -rotate-90">
        {/* Background circle */}
        <circle
          cx="70"
          cy="70"
          r="45"
          fill="none"
          stroke="#333333"
          strokeWidth="4"
        />
        {/* Progress circle */}
        <circle
          cx="70"
          cy="70"
          r="45"
          fill="none"
          stroke="#00ff00"
          strokeWidth="4"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
      </svg>
      <div className="absolute text-center mt-4">
        <div className="text-3xl font-bold text-agency-green">
          {percentage.toFixed(0)}%
        </div>
        <div className="text-xs text-gray-400 mt-1">{label}</div>
      </div>
    </div>
  );
};

const MetricBox = ({ label, value, unit = '', subtext = '' }) => {
  return (
    <div className="bg-agency-dark border border-agency-gray p-4 rounded">
      <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">{label}</div>
      <div className="flex items-baseline gap-2">
        <div className="text-3xl font-bold text-agency-green">{value}</div>
        <div className="text-sm text-gray-400">{unit}</div>
      </div>
      {subtext && <div className="text-xs text-gray-500 mt-2">{subtext}</div>}
    </div>
  );
};

export default function Dashboard() {
  const [squareData, setSquareData] = useState(null);
  const [webflowData, setWebflowData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [revenueHistory, setRevenueHistory] = useState([]);

  // Fetch data
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [squareRes, webflowRes] = await Promise.all([
          fetch('/api/square-revenue'),
          fetch('/api/webflow-posts'),
        ]);

        if (!squareRes.ok || !webflowRes.ok) {
          throw new Error('Failed to fetch data');
        }

        const squareJson = await squareRes.json();
        const webflowJson = await webflowRes.json();

        setSquareData(squareJson);
        setWebflowData(webflowJson);
        setLastUpdated(new Date());
        setError(null);

        // Mock revenue history (in production, you'd fetch this from your API)
        setRevenueHistory([
          { date: 'Mon', revenue: 3200 },
          { date: 'Tue', revenue: 2400 },
          { date: 'Wed', revenue: 2210 },
          { date: 'Thu', revenue: 2290 },
          { date: 'Fri', revenue: 2000 },
          { date: 'Sat', revenue: 2181 },
          { date: 'Sun', revenue: 2500 },
        ]);
      } catch (err) {
        console.error('Error fetching data:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5 * 60 * 1000); // Refresh every 5 minutes

    return () => clearInterval(interval);
  }, []);

  if (loading && !squareData) {
    return (
      <div className="min-h-screen bg-agency-black text-agency-green font-terminal flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl mb-4">INITIALIZING TACTICAL BRIEFING...</div>
          <div className="text-sm text-gray-400">Connecting to data sources</div>
        </div>
      </div>
    );
  }

  const monthlyTarget = 32000;
  const monthlyProgress = squareData?.thisMonth?.total || 0;
  const monthlyPercentage = (monthlyProgress / monthlyTarget) * 100;

  const jobsTarget = 20;
  const jobsCompleted = squareData?.thisMonth?.count || 0;
  const jobsPercentage = (jobsCompleted / jobsTarget) * 100;

  return (
    <div className="min-h-screen bg-agency-black text-white font-terminal p-8">
      {/* Background grid effect */}
      <div className="fixed inset-0 opacity-5 pointer-events-none">
        <div className="absolute inset-0" style={{
          backgroundImage: 'linear-gradient(rgba(0,255,0,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,0,0.1) 1px, transparent 1px)',
          backgroundSize: '20px 20px'
        }} />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-12 border-b border-agency-gray pb-6">
          <h1 className="text-5xl font-bold text-agency-green mb-2">THE AGENCY</h1>
          <div className="flex justify-between items-center">
            <p className="text-sm text-gray-400 uppercase tracking-widest">Tactical Business Intelligence</p>
            <div className="text-xs text-gray-500">
              Last updated: {lastUpdated.toLocaleTimeString()}
              {error && <span className="text-red-500 ml-4">⚠ Error: {error}</span>}
            </div>
          </div>
        </div>

        {/* Top Metrics Row */}
        <div className="grid grid-cols-3 gap-6 mb-10">
          <MetricBox
            label="All-Time Revenue"
            value={`$${(squareData?.allTime?.total || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
            subtext={`${squareData?.allTime?.count || 0} completed jobs`}
          />
          <MetricBox
            label="This Month"
            value={`$${(monthlyProgress).toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
            subtext={`${monthlyPercentage.toFixed(0)}% of $${monthlyTarget.toLocaleString()}`}
          />
          <MetricBox
            label="Today"
            value={`$${(squareData?.today?.total || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
            subtext={`Avg Job: $${(squareData?.allTime?.avgValue || 0).toFixed(2)}`}
          />
        </div>

        {/* Gauges Row */}
        <div className="grid grid-cols-3 gap-6 mb-10">
          <div className="bg-agency-dark border border-agency-gray p-6 rounded flex flex-col items-center">
            <GaugeCircle value={monthlyProgress} max={monthlyTarget} label="Monthly Target" />
          </div>
          <div className="bg-agency-dark border border-agency-gray p-6 rounded flex flex-col items-center">
            <GaugeCircle value={jobsCompleted} max={jobsTarget} label="Jobs This Month" />
          </div>
          <div className="bg-agency-dark border border-agency-gray p-6 rounded flex flex-col items-center">
            <GaugeCircle value={75} max={100} label="Margin %" />
          </div>
        </div>

        {/* Revenue Chart */}
        <div className="bg-agency-dark border border-agency-gray p-6 rounded mb-10">
          <h2 className="text-sm text-gray-400 uppercase tracking-wider mb-4">Revenue Trend (7 Days)</h2>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={revenueHistory}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333333" />
              <XAxis dataKey="date" stroke="#666666" style={{ fontSize: '12px' }} />
              <YAxis stroke="#666666" style={{ fontSize: '12px' }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1a1a1a',
                  border: '1px solid #333333',
                  color: '#00ff00',
                }}
              />
              <Line
                type="monotone"
                dataKey="revenue"
                stroke="#00ff00"
                strokeWidth={2}
                dot={{ fill: '#00ff00', r: 4 }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Content & Geo Row */}
        <div className="grid grid-cols-2 gap-6 mb-10">
          {/* Blog Posts */}
          <div className="bg-agency-dark border border-agency-gray p-6 rounded">
            <h3 className="text-xs text-gray-400 uppercase tracking-wider mb-6">Content Pipeline</h3>
            <div className="space-y-4">
              <MetricBox
                label="Blog Posts Live"
                value={webflowData?.published || 0}
                subtext="Installation posts on Webflow"
              />
              <MetricBox
                label="Draft Posts"
                value={webflowData?.draft || 0}
                subtext="Awaiting publication"
              />
              <MetricBox
                label="Social Ready"
                value="3"
                subtext="Pending copy/paste to platforms"
              />
            </div>
          </div>

          {/* Geographic Distribution */}
          <div className="bg-agency-dark border border-agency-gray p-6 rounded">
            <h3 className="text-xs text-gray-400 uppercase tracking-wider mb-6">Geographic Distribution</h3>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">Minneapolis (MSP)</span>
                  <span className="text-agency-green">81%</span>
                </div>
                <div className="h-2 bg-agency-gray rounded overflow-hidden">
                  <div className="h-full bg-agency-green" style={{ width: '81%' }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">Houston (HOU)</span>
                  <span className="text-agency-green">12%</span>
                </div>
                <div className="h-2 bg-agency-gray rounded overflow-hidden">
                  <div className="h-full bg-agency-green" style={{ width: '12%' }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">Austin (AUS)</span>
                  <span className="text-agency-green">7%</span>
                </div>
                <div className="h-2 bg-agency-gray rounded overflow-hidden">
                  <div className="h-full bg-agency-green" style={{ width: '7%' }} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Status */}
        <div className="border-t border-agency-gray pt-6 text-xs text-gray-500">
          <div className="flex justify-between items-center">
            <span>✓ Square API Connected | ✓ Webflow API Connected | ✓ All Systems Green</span>
            <span>Dashboard v1.0 | Last sync: {lastUpdated.toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
