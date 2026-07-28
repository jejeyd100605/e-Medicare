/* ============================================================
   e-Medicare — Barangay Bambang Admin Control Center
   REPORTS & ANALYTICS MODULE
   Response-time performance, request volume, fleet utilization,
   and CSV export of system data. Read-only: this module never
   writes to DB, it only reads and computes.
   Depends on helpers already in admin.js:
   load(), save(), fmtTime(), timeAgo(), statusClass()
   ============================================================ */

async function renderReports(){
  renderResponseSummary();
  await renderRequestVolume();
  renderFleetUtilization();
}

/* ---------------------------------------------------------
   RESPONSE PERFORMANCE
   Uses incident.reportedAt vs. the first 'dispatch' activity
   log entry that mentions the incident's caller/location as a
   proxy for "time to dispatch" (no separate dispatchedAt field
   exists on the incident record itself).
--------------------------------------------------------- */
function findDispatchTime(incident){
  const acts = load(DB.activity, []);
  const match = acts.find(a =>
    a.type === 'dispatch' &&
    a.message.includes(incident.location) &&
    new Date(a.at) >= new Date(incident.reportedAt)
  );
  return match ? new Date(match.at) : null;
}

function renderResponseSummary(){
  const incidents = load(DB.incidents, []);
  const rows = incidents.map(i => {
    const dispatchTime = findDispatchTime(i);
    const minutes = dispatchTime
      ? Math.round((dispatchTime - new Date(i.reportedAt)) / 60000)
      : null;
    return { ...i, minutes };
  });

  const timed = rows.filter(r => r.minutes !== null);
  const avgAll = timed.length
    ? Math.round(timed.reduce((s,r) => s + r.minutes, 0) / timed.length)
    : null;

  const avgEl = document.getElementById('repAvgResponse');
  if(avgEl) avgEl.textContent = avgAll !== null ? avgAll + ' min' : 'No data yet';

  // group by incident type
  const byType = {};
  timed.forEach(r => {
    byType[r.type] = byType[r.type] || [];
    byType[r.type].push(r.minutes);
  });

  const wrap = document.getElementById('repResponseByType');
  if(!wrap) return;
  const types = Object.keys(byType);
  if(types.length === 0){
    wrap.innerHTML = '<div class="empty-state">No dispatched incidents recorded yet.</div>';
    return;
  }
  const maxAvg = Math.max(...types.map(t => byType[t].reduce((s,v)=>s+v,0)/byType[t].length));
  wrap.innerHTML = types.map(t => {
    const vals = byType[t];
    const avg = Math.round(vals.reduce((s,v)=>s+v,0)/vals.length);
    const pct = maxAvg ? Math.round((avg / maxAvg) * 100) : 0;
    return `
      <div class="report-bar-row">
        <div class="report-bar-label">${t} <span style="color:#888;">(${vals.length})</span></div>
        <div class="report-bar-track"><div class="report-bar-fill" style="width:${pct}%;"></div></div>
        <div class="report-bar-value">${avg} min</div>
      </div>
    `;
  }).join('');
}

/* ---------------------------------------------------------
   REQUEST VOLUME (by category + status)
--------------------------------------------------------- */
async function renderRequestVolume(){
  const { data: requests, error } = await supabase
    .from('medical_assistance_requests')
    .select('*');

  if (error) {
    console.error('Hindi makuha ang requests:', error.message);
    return;
  }

  document.getElementById('repTotalRequests') && (document.getElementById('repTotalRequests').textContent = requests.length);

  const wrap = document.getElementById('repRequestVolume');
  if(!wrap) return;
  if(requests.length === 0){
    wrap.innerHTML = '<div class="empty-state">No assistance requests submitted yet.</div>';
    return;
  }

  const byCategory = {};
  const byStatus = {};
  requests.forEach(r => {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  });

  const catRows = Object.keys(byCategory).map(cat => {
    const pct = Math.round((byCategory[cat] / requests.length) * 100);
    return `
      <div class="report-bar-row">
        <div class="report-bar-label">${cat}</div>
        <div class="report-bar-track"><div class="report-bar-fill" style="width:${pct}%; background:#ff9100;"></div></div>
        <div class="report-bar-value">${byCategory[cat]}</div>
      </div>`;
  }).join('');

  const statusChips = Object.keys(byStatus).map(st => `
    <span class="status-pill ${statusClass(st)}" style="margin:3px 6px 3px 0;">${st}: ${byStatus[st]}</span>
  `).join('');

  wrap.innerHTML = `
    <div style="margin-bottom:12px;">${catRows}</div>
    <div style="font-size:0.75em; color:#888; margin-bottom:6px;">By current status:</div>
    <div>${statusChips}</div>
  `;
}

/* ---------------------------------------------------------
   FLEET / PERSONNEL UTILIZATION
   Approximation: since we only store current status + lastUpdated
   (no full state-change history per unit), utilization here means
   "share of the fleet currently in each status" — a live snapshot
   metric rather than a time-integrated one. This is flagged in the
   UI copy so it isn't mistaken for a historical utilization rate.
--------------------------------------------------------- */
function renderFleetUtilization(){
  const fleet = load(DB.fleet, []);
  const totalEl = document.getElementById('repFleetUtil');
  const wrap = document.getElementById('repFleetUtilList');
  if(!wrap) return;

  if(fleet.length === 0){
    if(totalEl) totalEl.textContent = '0%';
    wrap.innerHTML = '<div class="empty-state">No fleet resources registered yet.</div>';
    return;
  }

  const onDuty = fleet.filter(f => f.status === 'On Duty').length;
  const pct = Math.round((onDuty / fleet.length) * 100);
  if(totalEl) totalEl.textContent = pct + '%';

  wrap.innerHTML = fleet.map(f => `
    <div class="fleet-quick-row">
      <div>
        <div class="fleet-quick-name">${f.name}</div>
        <div class="fleet-quick-type">${f.type} · updated ${timeAgo(f.lastUpdated)}</div>
      </div>
      <span class="status-pill ${statusClass(f.status)}"><span class="status-dot"></span>${f.status}</span>
    </div>
  `).join('') + `
    <p style="font-size:0.68em; color:#666; margin-top:10px;">
      Snapshot of current status distribution. For time-weighted utilization,
      fleet status-change history would need to be logged per unit over time.
    </p>
  `;
}

/* ---------------------------------------------------------
   CSV EXPORT
--------------------------------------------------------- */
function toCSV(rows){
  if(rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (val) => {
    const s = (val === null || val === undefined) ? '' : String(val);
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [headers.join(',')];
  rows.forEach(row => {
    lines.push(headers.map(h => escape(row[h])).join(','));
  });
  return lines.join('\n');
}

function downloadCSV(filename, csvContent){
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportData(type){
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  let rows = [];
  let filename = '';

  if(type === 'incidents'){
    rows = load(DB.incidents, []).map(i => ({
      id: i.id, type: i.type, caller: i.caller, location: i.location,
      status: i.status, reportedAt: i.reportedAt
    }));
    filename = `bambang-incidents-${stamp}.csv`;
  } else if(type === 'requests'){
    rows = load(DB.requests, []).map(r => ({
      id: r.id, residentName: r.residentName, category: r.category,
      priority: r.priority, estimatedCost: r.estimatedCost,
      status: r.status, submittedAt: r.submittedAt
    }));
    filename = `bambang-assistance-requests-${stamp}.csv`;
  } else if(type === 'fleet'){
    rows = load(DB.fleet, []).map(f => ({
      id: f.id, name: f.name, type: f.type, plate: f.plate,
      status: f.status, lastUpdated: f.lastUpdated
    }));
    filename = `bambang-fleet-roster-${stamp}.csv`;
  } else if(type === 'activity'){
    rows = load(DB.activity, []).map(a => ({
      id: a.id, type: a.type,
      message: a.message.replace(/<[^>]+>/g, ''), // strip HTML tags
      at: a.at
    }));
    filename = `bambang-activity-log-${stamp}.csv`;
  }

  if(rows.length === 0){
    alert('No data available to export for this category yet.');
    return;
  }

  downloadCSV(filename, toCSV(rows));
  logActivity('request', `System data exported: <b>${type}</b> (${rows.length} records).`);
}