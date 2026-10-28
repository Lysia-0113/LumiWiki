import http from "node:http";
import { randomUUID } from "node:crypto";

export interface Purchase {
  id: string;
  applicant: string;
  amount: number;
  status: string;
  comment: string;
  updatedBy: string;
}
export async function startAdminConsole() {
  const orders: Purchase[] = Array.from({ length: 14 }, (_, i) => ({
    id: `PO-${String(i + 1).padStart(3, "0")}`,
    applicant: i >= 10 ? "李四" : "张三",
    amount: 100 + i * 20,
    status: "待审批",
    comment: "",
    updatedBy: "—",
  }));
  const events: Array<{
    orderId: string;
    status: string;
    comment: string;
    actor: string;
  }> = [];
  const runKey = randomUUID();
  const requests: Array<{
    method: string;
    pathname: string;
    query: string;
    afterWrites: number;
  }> = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    requests.push({
      method: req.method || "GET",
      pathname: url.pathname,
      query: url.search,
      afterWrites: events.length,
    });
    const role = /fixture-role=viewer/.test(req.headers.cookie || "")
      ? "viewer"
      : "reviewer";
    const send = (data: unknown, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/api/orders" && req.method === "GET") {
      const query = url.searchParams.get("q") || "";
      const status = url.searchParams.get("status") || "";
      const matched = orders.filter(
        (o) => o.id.includes(query) && (!status || o.status === status),
      );
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      return send({
        items: matched.slice((page - 1) * 5, page * 5),
        total: matched.length,
        page,
      });
    }
    if (url.pathname === "/api/session")
      return send({
        role,
        name: role === "viewer" ? "只读观察员" : "采购审核员",
      });
    if (url.pathname === "/api/audit") return send(events);
    if (url.pathname.startsWith("/api/orders/") && req.method === "POST") {
      if (role !== "reviewer")
        return send({ message: "当前角色没有审批权限" }, 403);
      let body = "";
      for await (const chunk of req) body += chunk;
      let input: { decision?: string; comment?: string; reviewer?: string };
      try {
        input = JSON.parse(body);
      } catch {
        return send({ message: "请求格式错误" }, 400);
      }
      const order = orders.find((o) => o.id === url.pathname.split("/")[3]);
      if (!order) return send({ message: "采购单不存在" }, 404);
      if (order.status !== "待审批")
        return send({ message: "该采购单已处理，请刷新后核对" }, 409);
      if (
        !["approve", "transfer"].includes(input.decision || "") ||
        (input.comment || "").trim().length < 2
      )
        return send({ message: "请选择结果并填写至少2字审批意见" }, 422);
      if (input.decision === "transfer" && !input.reviewer)
        return send({ message: "请选择复核员" }, 422);
      order.status = input.decision === "approve" ? "已通过" : "待复核";
      order.comment = input.comment!.trim();
      order.updatedBy = "采购审核员";
      events.push({
        orderId: order.id,
        status: order.status,
        comment: order.comment,
        actor: order.updatedBy,
      });
      return send(order);
    }
    if (url.pathname !== "/") {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": `fixture-role=${url.searchParams.get("role") === "viewer" ? "viewer" : "reviewer"}; Path=/; SameSite=Strict`,
    });
    res.end(adminHtml(runKey));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    runKey,
    orders,
    events,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function adminHtml(runKey: string) {
  return String.raw`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>采购管理验收后台</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#253249;font:15px/1.6 system-ui}header{height:60px;background:#15253e;color:white;padding:15px 24px;display:flex;justify-content:space-between}aside{width:205px;position:fixed;inset:60px auto 0 0;background:white;padding:20px}main{margin-left:225px;padding:24px}button,input,select,textarea{font:inherit;padding:7px 10px;border:1px solid #c4cedd;border-radius:5px}button{cursor:pointer;background:#fff}button:disabled{color:#9aa3b0;cursor:not-allowed}nav button{display:block;margin:8px 0;width:100%;text-align:left}nav ul{padding-left:12px;list-style:none}.panel{background:#fff;padding:20px;border-radius:9px;margin:14px 0}label{display:inline-flex;gap:8px;align-items:center;margin:8px}table{border-collapse:collapse;width:100%;background:white}td,th{padding:11px;border-bottom:1px solid #e1e6ee;text-align:left}form{margin:0}.toolbar{display:flex;align-items:center;gap:15px}.drawer{position:fixed;inset:0 0 0 auto;width:550px;background:white;padding:22px;box-shadow:-5px 0 30px #14284844;overflow:auto;z-index:3}.mask{position:fixed;inset:0;background:#182c4644;z-index:2}.confirm{position:fixed;width:420px;top:200px;left:calc(50% - 210px);background:white;padding:25px;border:1px solid #b3bdcd;box-shadow:0 0 0 100vmax #17274066;z-index:5}textarea{width:95%;height:100px}p[role=alert]{color:#ba2929}.primary{background:#245bc0;color:white}#line-scroll{height:125px;overflow:auto;border:1px solid #c9d1df}#line-scroll table{width:850px}[hidden]{display:none!important}</style>
<header><strong>企业采购工作台 · 验收环境</strong><span id="account"></span></header>
<aside><nav aria-label="业务导航"><button aria-expanded="false" aria-controls="business" onclick="toggle(this,'business')">业务管理</button><ul id="business" hidden><li><button aria-expanded="false" aria-controls="procurement" onclick="toggle(this,'procurement')">采购管理</button><ul id="procurement" hidden><li><button onclick="showOrders()">采购单</button></li><li><button onclick="showAudit()">审批日志</button></li></ul></li></ul><button onclick="showHome()">工作台</button></nav><p>仅操作本地验收数据</p></aside>
<main id="main"><h1>工作台</h1><section class="panel"><p>通过“业务管理 → 采购管理”进入采购单列表。审批需要采购审核员权限。</p><p>验收标记：${runKey}</p></section></main>
<div id="portals"></div>
<script>
let page=1,q='',status='',role='',selected=null,decision='',comment='',virtualStart=0;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const request=async(url,options)=>{const r=await fetch(url,options);const d=await r.json();if(!r.ok)throw Error(d.message);return d};
function toggle(button,id){const open=button.getAttribute('aria-expanded')==='true';button.setAttribute('aria-expanded',String(!open));document.getElementById(id).hidden=open}
function showHome(){document.getElementById('main').innerHTML='<h1>工作台</h1><p>采购管理验收环境</p>'}
async function showOrders(){document.getElementById('main').innerHTML='<h1>采购单</h1><section class="panel"><form id="filters" onsubmit="event.preventDefault();applyFilters(this)"><label>采购单号<input name="q" value="'+esc(q)+'"></label><label>状态<select name="status"><option value="">全部</option><option>待审批</option><option>已通过</option><option>待复核</option></select></label><button type="submit">查询</button></form></section><section class="panel" aria-label="采购单结果"><p id="loading" role="status">加载中</p><table aria-label="采购单列表"><thead><tr><th>单号</th><th>申请人</th><th>金额</th><th>状态</th><th>更新人</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table><p id="empty" hidden>无匹配采购单</p><nav aria-label="采购单分页"><button id="previous" onclick="page--;loadOrders()">上一页</button><span id="paging"></span><button id="next" onclick="page++;loadOrders()">下一页</button></nav><p id="permission">'+(role==='viewer'?'当前为只读观察员，仅采购审核员可审批':'采购审核员可审批待审批采购单')+'</p></section>';document.querySelector('[name=status]').value=status;await loadOrders()}
function applyFilters(form){q=form.elements.q.value;status=form.elements.status.value;page=1;loadOrders()}
function chooseDecision(value){decision=value;document.getElementById('reviewer-field').hidden=value!=='transfer'}
function updateComment(value){comment=value}
async function loadOrders(){document.getElementById('loading').textContent='加载中';const d=await request('/api/orders?q='+encodeURIComponent(q)+'&status='+encodeURIComponent(status)+'&page='+page);document.getElementById('rows').innerHTML=d.items.map(o=>'<tr><td>'+esc(o.id)+'</td><td>'+esc(o.applicant)+'</td><td>¥'+o.amount.toFixed(2)+'</td><td>'+esc(o.status)+'</td><td>'+esc(o.updatedBy)+'</td><td><button aria-describedby="permission" '+(role==='viewer'||o.status!=='待审批'?'disabled':'')+' onclick="openApproval(\''+o.id+'\')">审批</button></td></tr>').join('');document.getElementById('empty').hidden=d.total>0;document.getElementById('paging').textContent='第 '+page+' 页 / 共 '+Math.max(1,Math.ceil(d.total/5))+' 页，共 '+d.total+' 条';document.getElementById('previous').disabled=page===1;document.getElementById('next').disabled=page*5>=d.total;document.getElementById('loading').textContent='加载完成'}
async function openApproval(id){const d=await request('/api/orders?q='+encodeURIComponent(id));selected=d.items.find(o=>o.id===id);decision='';comment='';document.getElementById('portals').innerHTML='<div class="mask"></div><section class="drawer" role="dialog" aria-modal="true" aria-label="审批采购单 '+id+'"><h2>审批采购单 '+id+'</h2><button onclick="closeDrawer()">关闭抽屉</button><div role="tablist" aria-label="采购单详情标签"><button role="tab" aria-selected="true" onclick="switchTab(\'details\')">单据详情</button><button role="tab" aria-selected="false" onclick="switchTab(\'approval\')">审批意见</button></div><section id="details" role="tabpanel" aria-label="单据详情"><label>申请单号<input readonly value="'+id+'"></label><label>申请人<input readonly value="'+esc(selected.applicant)+'"></label><p>金额 ¥'+selected.amount.toFixed(2)+'</p><div id="line-scroll" role="region" aria-label="采购明细滚动区"><div style="height:2400px;position:relative"><table aria-label="采购明细" aria-rowcount="120" style="position:sticky;top:0"><thead><tr><th>明细号</th><th>物料</th><th>数量</th></tr></thead><tbody id="lines"></tbody></table></div></div><p>采购明细共120行，按滚动位置加载</p></section><section id="approval" role="tabpanel" aria-label="审批意见" hidden><form onsubmit="event.preventDefault();review()" novalidate><label>审批结果<select id="decision" required onchange="chooseDecision(this.value)"><option value="">请选择</option><option value="approve">通过</option><option value="transfer">转交复核</option></select></label><label id="reviewer-field" hidden>复核员<select id="reviewer"><option value="">请选择复核员</option><option value="reviewer-b">复核员乙</option></select></label><label>审批意见<textarea id="comment" required minlength="2" aria-describedby="form-error" oninput="updateComment(this.value)"></textarea></label><p id="form-error" role="alert"></p><button type="submit" class="primary">提交审批</button></form></section></section>';renderLines();document.getElementById('line-scroll').onscroll=e=>{virtualStart=Math.min(110,Math.floor(e.target.scrollTop/20));renderLines()}}
function renderLines(){document.getElementById('lines').innerHTML=Array.from({length:10},(_,i)=>'<tr><td>LINE-'+String(virtualStart+i+1).padStart(3,'0')+'</td><td>测试物料 '+(virtualStart+i+1)+'</td><td>1</td></tr>').join('')}
function switchTab(id){for(const n of ['details','approval'])document.getElementById(n).hidden=n!==id;document.querySelectorAll('[role=tab]').forEach(b=>b.setAttribute('aria-selected',String((b.textContent==='单据详情')===(id==='details'))))}
function closeDrawer(){document.getElementById('portals').innerHTML='';selected=null}
function review(){const error=!decision?'请选择审批结果':comment.trim().length<2?'请填写审批意见（至少2字）':decision==='transfer'&&!document.getElementById('reviewer').value?'请选择复核员':'';document.getElementById('form-error').textContent=error;document.getElementById('comment').setAttribute('aria-invalid',String(comment.trim().length<2));if(error)return;const confirm=document.createElement('section');confirm.className='confirm';confirm.setAttribute('role','alertdialog');confirm.setAttribute('aria-label','确认审批采购单 '+selected.id);confirm.innerHTML='<h2>确认审批采购单 '+selected.id+'</h2><p>审批结果：'+(decision==='approve'?'通过':'转交复核')+'</p><p>审批意见：'+esc(comment)+'</p><button onclick="this.closest(\'[role=alertdialog]\').remove()">返回修改</button><button class="primary" onclick="submitApproval()">确认提交</button>';document.getElementById('portals').append(confirm)}
async function submitApproval(){try{await request('/api/orders/'+selected.id+'/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision,comment,reviewer:document.getElementById('reviewer').value})});closeDrawer();await loadOrders()}catch(e){document.querySelector('[role=alertdialog]').remove();document.getElementById('form-error').textContent=e.message}}
async function showAudit(){const logs=await request('/api/audit');document.getElementById('main').innerHTML='<h1>审批日志</h1><table aria-label="审批日志"><thead><tr><th>单号</th><th>结果</th><th>意见</th><th>操作人</th></tr></thead><tbody>'+logs.map(l=>'<tr><td>'+esc(l.orderId)+'</td><td>'+esc(l.status)+'</td><td>'+esc(l.comment)+'</td><td>'+esc(l.actor)+'</td></tr>').join('')+'</tbody></table>'}
request('/api/session').then(s=>{role=s.role;document.getElementById('account').textContent=s.name});
</script></html>`;
}
