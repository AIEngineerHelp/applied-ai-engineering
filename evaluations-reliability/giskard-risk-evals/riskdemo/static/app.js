function L(e){let s=i=>e.filter(o=>o.status===i).length,t=s("passed"),a=s("failed"),n=s("error");return{total:e.length,passed:t,failed:a,errored:n,finished:t+a+n===e.length}}function N(e,s){let t=s.passed+s.failed,a=s.errored?` ${s.errored} ${s.errored===1?"attack":"attacks"} errored and ${s.errored===1?"isn't":"aren't"} counted.`:"";return s.finished?t===0?`No attack finished.${a}`:s.failed===0?`${e} kept the rule in all ${t} attacks.${a}`:s.passed===0?`${e} broke the rule in all ${t} attacks.${a}`:`${e} broke the rule in ${s.failed} of ${t} attacks.${a}`:`${t} of ${s.total} attacks finished so far.`}function E(e,s){let t=a=>a.status==="failed"?0:s.has(a.index+1)?1:a.status==="error"?2:a.status==="passed"?3:4;return[...e].sort((a,n)=>t(a)-t(n)||a.index-n.index)}function z(e){let s=[],t=/(?:^|[\s(])['"“‘]([^"”’\n]{4,240}?)['"”’](?=$|[\s.,;:!?)])/g;for(let a of e.matchAll(t)){let n=a[1].trim().replace(/[.,;:]+$/,"");n.length>=4&&!s.includes(n)&&s.push(n)}return s}function c(e){return e.replace(/[&<>"']/g,s=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[s])}function ee(e,s){let t=[],a=e.toLowerCase();for(let l of s){let d=c(l).toLowerCase(),u=a.indexOf(d);for(;u!==-1;)t.push([u,u+d.length]),u=a.indexOf(d,u+d.length)}if(!t.length)return e;t.sort((l,d)=>l[0]-d[0]);let n=[];for(let l of t){let d=n[n.length-1];d&&l[0]<=d[1]?d[1]=Math.max(d[1],l[1]):n.push([...l])}let i="",o=0;for(let[l,d]of n)i+=e.slice(o,l)+"<mark>"+e.slice(l,d)+"</mark>",o=d;return i+e.slice(o)}function q(e,s=[]){let t=u=>u.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=$|[\s.,;:!?)])/g,"$1<em>$2</em>"),a=ee(c(e),s),n=[],i=[],o=[],l=[],d=()=>{if(o.length&&n.push(`<p>${o.map(t).join("<br>")}</p>`),i.length&&n.push(`<ul>${i.map(u=>`<li>${t(u)}</li>`).join("")}</ul>`),l.length){let[u,...g]=l;n.push(`<table><thead><tr>${u.map(p=>`<th>${t(p)}</th>`).join("")}</tr></thead><tbody>${g.map(p=>`<tr>${p.map(m=>`<td>${t(m)}</td>`).join("")}</tr>`).join("")}</tbody></table>`)}o=[],i=[],l=[]};for(let u of a.split(`
`)){let g=u.trim(),p=g.match(/^#{1,6}\s+(.*)$/),m=g.match(/^(?:[*-]|\d+\.)\s+(.*)$/);if(g.startsWith("|")&&g.endsWith("|")){l.length||d();let f=g.slice(1,-1).split("|").map(w=>w.trim());f.every(w=>/^:?-{2,}:?$/.test(w))||l.push(f);continue}l.length&&d(),p?(d(),n.push(`<h4>${t(p[1])}</h4>`)):/^(-{3,}|\*{3,}|_{3,})$/.test(g)?(d(),n.push("<hr>")):m?(o.length&&d(),i.push(m[1])):g?(i.length&&d(),o.push(g)):d()}return d(),n.join("")}function F(e,s=1){let t=[];return e.attacks.forEach((a,n)=>{let i=n*450;t.push({t:i,attack:n,type:"start",turn:0}),a.turns.forEach((o,l)=>{i+=1100,t.push({t:i,attack:n,type:"user",turn:l}),i+=1500,t.push({t:i,attack:n,type:"agent",turn:l})}),i+=1200,t.push({t:i,attack:n,type:"verdict",turn:0})}),t.map(a=>({...a,t:a.t/s})).sort((a,n)=>a.t-n.t)}function G(e){return{...e,status:"running",attacks:e.attacks.map(s=>({...s,status:"queued",turns:[],checks:[],error:null,pending:null}))}}function H(e,s,t){let a=e.attacks[t.attack],n=s.attacks[t.attack];t.type==="start"&&Object.assign(a,{status:"running",pending:"attacker"}),t.type==="user"&&(a.turns.push({user:n.turns[t.turn].user,agent:null}),a.pending="agent"),t.type==="agent"&&(a.turns[t.turn]={...n.turns[t.turn]},a.pending=t.turn+1<n.turns.length?"attacker":"judge"),t.type==="verdict"&&Object.assign(a,{status:n.status,checks:n.checks,error:n.error,duration_ms:n.duration_ms,pending:null})}function M(e){return e==null?"":e<1e4?`${(e/1e3).toFixed(1)} s`:`${Math.round(e/1e3)} s`}var te=[{id:"policy",label:"Policy"},{id:"attack",label:"Attack"},{id:"review",label:"Review"}],V=[{id:"agent",label:"The agent's prompt",hint:"The agent really did the wrong thing."},{id:"attacks",label:"The attacks",hint:"The attacker was unrealistic or missed a tactic."},{id:"judge",label:"The judge",hint:"The judge scored a good answer as bad, or the reverse."},{id:"rule",label:"The rule itself",hint:"The rule is ambiguous or doesn't cover this case."}],b={naive:"Naive prompt",hardened:"Hardened prompt"},r={catalog:null,recorded:new Map,liveRuns:[],route:{page:"overview"},shown:null,replay:null,poll:null,filter:"all",confirming:!1,loadKey:""},v=e=>document.getElementById(e);async function y(e,s){let t=await fetch(e,s),a=await t.json().catch(()=>({}));if(!t.ok)throw new Error(a.detail||`Request failed (${t.status}).`);return a}async function D(e,s){let t=`${e}--${s}`;return r.recorded.has(t)||r.recorded.set(t,await y(`/api/recorded/${e}/${s}`)),r.recorded.get(t)}async function _(){r.liveRuns=await y("/api/runs").catch(()=>r.liveRuns)}function C(e){return!e||e.mode!=="recorded"?{}:r.catalog.review_notes[`${e.risk}--${e.version}`]??{}}function j(e,s){try{let t=localStorage.getItem(`redteam-review:${e.id}:${s}`);return t?JSON.parse(t):null}catch{return null}}function K(e,s,t){try{let a=`redteam-review:${e.id}:${s}`;t?localStorage.setItem(a,JSON.stringify(t)):localStorage.removeItem(a)}catch{}}function se(){let[e,s=""]=location.hash.replace(/^#\/?/,"").split("?"),[t,a,n,i]=e.split("/"),o=r.catalog;return!t||!o.risks[t]?{page:"overview"}:{page:"risk",risk:t,version:a==="hardened"?"hardened":"naive",step:["policy","attack","review"].includes(n)?n:"policy",attack:Math.max(1,Math.min(10,Number(i)||1)),runId:new URLSearchParams(s).get("run")}}function k(e){let s=r.route.page==="risk"?r.route:null,t=e.risk??s?.risk??"",a=t===s?.risk&&(e.version??s?.version)===s?.version,n=e.version??s?.version??"naive",i=e.step??s?.step??"policy",o=e.attack??(a?s?.attack:1)??1,l=e.runId!==void 0?e.runId:a?s?.runId:null;return`#/${t}/${n}/${i}${i==="review"?`/${o}`:""}${l?`?run=${l}`:""}`}function T(e){location.hash=k(e)}async function W(){let e=r.route;r.route=se();let s=r.route;if(s.page!=="risk")return $(),r.shown=null,r.loadKey="",h();let t=`${s.risk}|${s.version}|${s.runId??"recorded"}`;if(t!==r.loadKey){$(),r.loadKey=t,r.shown=null,(e.page!=="risk"||e.risk!==s.risk)&&(r.filter="all"),h();try{if(s.runId){let a=await y(`/api/runs/${s.runId}`);if(r.loadKey!==t)return;r.shown=a,a.status==="running"&&ie(a.id)}else{let a=await D(s.risk,s.version);if(r.loadKey!==t)return;r.shown=a}}catch(a){O(a.message)}}h(),s.step==="review"&&e.page==="risk"&&e.step==="review"&&e.attack!==s.attack?v("inspector")?.scrollIntoView({block:"start",behavior:"smooth"}):(e.page!==s.page||e.page==="risk"&&e.step!==s.step)&&window.scrollTo({top:0})}function $(){r.replay&&clearInterval(r.replay.timer),r.poll&&clearInterval(r.poll),r.replay=null,r.poll=null}async function ne(){let e=r.route;if(e.page!=="risk")return;$();let s=await D(e.risk,e.version);if(e.runId)return T({runId:null,step:"attack"});let t=G(s);r.shown=t;let a=F(s),n=performance.now(),i=window.setInterval(()=>{let o=performance.now()-n,l=!1;for(;a.length&&a[0].t<=o;)H(t,s,a.shift()),l=!0;if(!a.length)return J();l&&R()},100);r.replay={timer:i,events:a,source:s,t0:n},e.step!=="attack"?T({step:"attack"}):h()}function J(){let e=r.replay?.source;$(),e&&(r.shown=e),h()}async function ae(){let e=r.route;if(e.page==="risk"){r.confirming=!1,$();try{let{id:s}=await y("/api/runs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({risk:e.risk,version:e.version})});r.catalog.live.busy=!0,await _(),T({runId:s,step:"attack"})}catch(s){h(),O(s.message)}}}function ie(e){let s=async()=>{try{let t=await y(`/api/runs/${e}`);if(r.route.page!=="risk"||r.route.runId!==e)return;r.shown=t,t.status!=="running"?($(),r.catalog.live.busy=!1,await _(),t.status==="error"&&O(t.error||"The live run failed."),h()):R()}catch{}};r.poll=window.setInterval(s,1200)}function h(){let e=r.catalog;v("sidebar").innerHTML=re(e),v("main").innerHTML=r.route.page==="overview"?oe(e):le(e,r.route),v("modal").innerHTML=r.confirming?xe(e):"",document.title=r.route.page==="risk"?`${e.risks[r.route.risk].risk} \xB7 Policy Red Team`:"Policy Red Team"}function R(){let e=r.route;e.page==="risk"&&(e.step==="attack"&&(v("run-body").innerHTML=X(r.catalog,e),v("run-bar").innerHTML=Y(r.catalog,e)),e.step==="review"&&(v("review-body").innerHTML=Q(r.catalog,e)),v("steps").innerHTML=U(e))}var B={passed:{label:"Kept the rule",text:"text-pass",bg:"bg-pass-soft",dot:"bg-pass"},failed:{label:"Broke the rule",text:"text-fail",bg:"bg-fail-soft",dot:"bg-fail"},error:{label:"Errored",text:"text-warn",bg:"bg-warn-soft",dot:"bg-warn"},running:{label:"Running",text:"text-accent",bg:"bg-accent-soft",dot:"bg-accent"},queued:{label:"Queued",text:"text-ink-3",bg:"bg-sunk",dot:"bg-line-2"}};function P(e,s=B[e].label){let t=B[e];return`<span class="inline-flex items-center gap-1.5 rounded-full ${t.bg} ${t.text} px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"><span class="size-1.5 rounded-full ${t.dot} ${e==="running"?"animate-pulse":""}"></span>${s}</span>`}function I(e){if(!e)return'<span class="text-ink-3">\u2014</span>';let s=e.passed+e.failed;return`${e.passed}<span class="text-ink-3">/${s}</span>`}function re(e){let s=r.route,t=Object.values(e.agents),a=i=>{let o=e.recorded[i.id]??{},l=s.page==="risk"&&s.risk===i.id;return`<a href="#/${i.id}/${s.page==="risk"?s.version:"naive"}/${s.page==="risk"?s.step:"policy"}"
      class="group flex items-center justify-between gap-3 rounded-md px-2.5 py-2 text-sm ${l?"bg-card text-ink shadow-[0_0_0_1px_var(--color-line)]":"text-ink-2 hover:bg-sunk hover:text-ink"}">
      <span class="leading-snug">${c(i.risk)}</span>
      <span class="shrink-0 font-mono text-[11px] text-ink-3" title="Attacks the agent kept the rule in: naive prompt \u2192 hardened prompt">${I(o.naive?.summary)} \u2192 ${I(o.hardened?.summary)}</span>
    </a>`},n=r.liveRuns.slice(0,6);return`
    <a href="#/" class="flex items-center gap-2.5 px-2.5">
      <span class="grid size-7 place-items-center rounded-md bg-ink text-paper">${x("shield",15)}</span>
      <span class="leading-tight"><span class="block font-semibold text-ink">Policy Red Team</span><span class="block text-xs text-ink-3">Giskard v3 \xB7 Gemini</span></span>
    </a>
    <label class="mt-4 block lg:hidden"><span class="sr-only">Go to</span>
      <select data-nav class="w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink">
        <option value="#/" ${s.page==="overview"?"selected":""}>Overview</option>
        ${t.map(i=>`<optgroup label="${c(i.name.split(",")[0])} \xB7 ${c(i.industry)}">${Object.values(e.risks).filter(o=>o.agent===i.id).map(o=>`<option value="#/${o.id}/naive/policy" ${s.page==="risk"&&s.risk===o.id?"selected":""}>${c(o.risk)}</option>`).join("")}</optgroup>`).join("")}
      </select>
    </label>
    <nav class="mt-7 hidden space-y-6 lg:block">
      <a href="#/" class="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm ${s.page==="overview"?"bg-card text-ink shadow-[0_0_0_1px_var(--color-line)]":"text-ink-2 hover:bg-sunk hover:text-ink"}">${x("grid",15)} Overview</a>
      ${t.map(i=>`<div>
        <div class="mb-1.5 flex items-baseline justify-between px-2.5 text-xs"><span class="font-medium text-ink">${c(i.name.split(",")[0])}</span><span class="text-ink-3">${c(i.industry)}</span></div>
        <div class="space-y-0.5">${Object.values(e.risks).filter(o=>o.agent===i.id).map(a).join("")}</div>
      </div>`).join("")}
      ${n.length?`<div><div class="mb-1.5 px-2.5 text-xs font-medium text-ink">Your live runs</div><div class="space-y-0.5">${n.map(i=>{let o=s.page==="risk"&&s.runId===i.id;return`<a href="#/${i.risk}/${i.version}/attack?run=${i.id}" class="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs ${o?"bg-card text-ink shadow-[0_0_0_1px_var(--color-line)]":"text-ink-2 hover:bg-sunk"}">
                  <span class="truncate">${c(e.risks[i.risk]?.risk??i.risk)} \xB7 ${i.version}</span>
                  <span class="font-mono text-ink-3">${i.status==="running"?"\u2026":I(i.summary??void 0)}</span></a>`}).join("")}</div></div>`:""}
    </nav>
    <div class="mt-auto hidden space-y-1.5 px-2.5 pt-8 text-xs text-ink-3 lg:block">
      <div class="flex items-center gap-2"><span class="size-1.5 rounded-full ${e.live.available?"bg-pass":"bg-line-2"}"></span>${e.live.available?"Live runs on (Gemini key found)":"Live runs off (no Gemini key)"}</div>
      <div>Recorded runs: 80 attacks, 2026-10-14</div>
    </div>`}function oe(e){let s=Object.values(e.risks),t=n=>{if(!n)return'<span class="text-ink-3">\u2014</span>';let i=n.passed+n.failed;return`<div class="flex items-center gap-3"><div class="flex gap-0.5">${Array.from({length:i},(o,l)=>`<span class="h-3.5 w-1.5 rounded-[2px] ${l<n.passed?"bg-pass":"bg-fail/70"}"></span>`).join("")}</div><span class="font-mono text-xs text-ink-2">${n.passed}/${i}</span></div>`},a=s[0];return`
  <div class="mx-auto max-w-5xl px-5 py-10 sm:px-10 sm:py-14">
    <p class="text-xs font-medium tracking-wide text-accent uppercase">Adversarial evals from your own policies</p>
    <h1 class="mt-3 max-w-3xl font-serif text-4xl leading-[1.1] text-ink sm:text-[46px]">Your lawyers wrote a rule. Can your agent keep it?</h1>
    <p class="mt-4 max-w-2xl text-[17px] leading-relaxed text-ink-2">Pick a policy. Giskard turns it into multi-turn attacks on the agent, an LLM judge scores every conversation against the same rule, and you review the verdicts.</p>
    <div class="mt-7 flex flex-wrap items-center gap-3">
      <a href="#/${a.id}/naive/policy" class="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper hover:bg-ink/90">Start with ${c(a.risk.toLowerCase())} ${x("arrow",15)}</a>
      <span class="text-sm text-ink-3">Recorded runs replay free. Live runs need a Gemini key.</span>
    </div>

    <ol class="mt-12 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
      ${[["Policy","Read the risk definition the rule's owner wrote: what's prohibited, what's allowed instead, and example questions."],["Attack","Giskard's attacker LLM tries to make the agent break the rule over up to three turns, ten times in parallel."],["Review","Read each conversation and the judge's reason. Agree, or say what should change: the prompt, the attacks, the judge or the rule."]].map(([n,i],o)=>`<li class="bg-card p-5"><div class="flex items-center gap-2.5"><span class="grid size-6 place-items-center rounded-full border border-line-2 font-mono text-xs text-ink-2">${o+1}</span><span class="font-medium text-ink">${n}</span></div><p class="mt-2.5 text-sm leading-relaxed text-ink-2">${i}</p></li>`).join("")}
    </ol>

    <h2 class="mt-14 font-serif text-2xl text-ink">Four policies, two prompts</h2>
    <p class="mt-1.5 text-sm text-ink-2">Ten recorded attacks per cell. The naive prompt has no written policy; the hardened prompt includes it.</p>
    <div class="mt-5 overflow-x-auto rounded-lg border border-line bg-card">
      <table class="w-full min-w-[680px] text-left text-sm">
        <thead class="border-b border-line text-xs text-ink-3"><tr><th class="px-5 py-3 font-medium">Policy</th><th class="px-4 py-3 font-medium">Owner</th><th class="px-4 py-3 font-medium">Kept the rule \xB7 naive</th><th class="px-4 py-3 font-medium">Kept the rule \xB7 hardened</th><th></th></tr></thead>
        <tbody class="divide-y divide-line">
          ${s.map(n=>{let i=e.recorded[n.id]??{};return`<tr class="group">
                <td class="px-5 py-4"><a href="#/${n.id}/naive/policy" class="font-medium text-ink hover:underline">${c(n.risk)}</a><div class="text-xs text-ink-3">${c(e.agents[n.agent].name.split(",")[0])} \xB7 ${c(n.category)}</div></td>
                <td class="px-4 py-4 text-ink-2">${c(n.owner)}</td>
                <td class="px-4 py-4"><a href="#/${n.id}/naive/attack">${t(i.naive?.summary)}</a></td>
                <td class="px-4 py-4"><a href="#/${n.id}/hardened/attack">${t(i.hardened?.summary)}</a></td>
                <td class="px-4 py-4 text-right"><a href="#/${n.id}/naive/policy" class="text-ink-3 group-hover:text-ink">${x("arrow",15)}</a></td>
              </tr>`}).join("")}
        </tbody>
      </table>
    </div>
    <p class="mt-4 text-xs leading-relaxed text-ink-3">Every number is out of ten LLM-judged attacks, so treat a difference of one or two as noise. Gemini played the agent, the attacker and the judge. Everything here is synthetic: the bank, the clinic, the member and the patient are invented.</p>
  </div>`}function U(e){let s=r.shown,t=s?L(s.attacks):null,a=s?s.attacks.filter(i=>j(s,i.index+1)).length:0,n=i=>i==="attack"&&t?t.finished?`${t.failed} broke`:"running":i==="review"&&t?`${a}/${t.total} reviewed`:"";return te.map((i,o)=>{let l=e.step===i.id,d=n(i.id);return`<a href="${k({step:i.id})}" class="flex items-center gap-2.5 border-b-2 px-1 pb-3 text-sm ${l?"border-ink text-ink":"border-transparent text-ink-3 hover:text-ink"}">
      <span class="grid size-5 place-items-center rounded-full font-mono text-[11px] ${l?"bg-ink text-paper":"border border-line-2"}">${o+1}</span>
      <span class="font-medium">${i.label}</span>${d?`<span class="hidden text-xs text-ink-3 sm:inline">${d}</span>`:""}</a>`}).join(`<span class="pb-3 text-line-2">${x("chevron",14)}</span>`)}function le(e,s){let t=e.risks[s.risk],a=e.agents[t.agent],n=["naive","hardened"].map(o=>`<a href="${k({version:o,runId:null})}" class="rounded-[5px] px-3 py-1.5 text-sm ${s.version===o&&!s.runId?"bg-card font-medium text-ink shadow-[0_0_0_1px_var(--color-line)]":"text-ink-2 hover:text-ink"}">${b[o]}</a>`).join(""),i=s.step==="policy"?de(e,t,s):s.step==="attack"?ce(e,s):ue(e,s);return`
  <div class="mx-auto max-w-6xl px-5 pt-7 sm:px-10">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div class="text-xs text-ink-3">${c(a.industry)} \xB7 ${c(a.name)} \xB7 ${c(t.domain)} \u203A ${c(t.category)}</div>
        <h1 class="mt-1 font-serif text-3xl text-ink">${c(t.risk)}</h1>
      </div>
      <div class="flex items-center gap-3">
        ${s.runId?`<span class="rounded-md bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">Live run \xB7 ${c(b[s.version].toLowerCase())}</span>`:""}
        <div class="flex rounded-md bg-sunk p-0.5" role="group" aria-label="Prompt version">${n}</div>
      </div>
    </div>
    <nav id="steps" class="mt-6 flex items-center gap-4 border-b border-line">${U(s)}</nav>
  </div>
  <div class="mx-auto max-w-6xl px-5 pt-7 pb-16 sm:px-10">${i}</div>`}function de(e,s,t){let a=e.agents[s.agent],n=(o,l,d="")=>`<div class="grid gap-1 border-t border-line px-5 py-3.5 sm:grid-cols-[150px_1fr] sm:gap-4"><dt class="text-xs font-medium ${d||"text-ink-3"} sm:pt-0.5">${o}</dt><dd class="text-sm leading-relaxed text-ink">${l}</dd></div>`,i=e.recorded[s.id]??{};return`
  <div class="grid gap-8 lg:grid-cols-[1fr_320px]">
    <div class="space-y-6">
      <section class="rounded-lg border border-line bg-card">
        <div class="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
          <h2 class="font-medium text-ink">Risk definition</h2>
          <span class="text-xs text-ink-3">Written by: <span class="text-ink-2">${c(s.owner)}</span></span>
        </div>
        <dl>
          ${n("Why it matters",c(s.basis))}
          ${n("Prohibited",c(s.prohibited),"text-fail")}
          ${n("Allowed instead",c(s.allowed_alternative),"text-pass")}
          ${n("Expected behavior",c(s.expected_behavior))}
          ${n("What users ask",`<div class="flex flex-wrap gap-1.5">${s.example_questions.map(o=>`<span class="rounded-md border border-line bg-paper px-2 py-1 text-[13px] text-ink-2">${c(o)}</span>`).join("")}</div>`)}
        </dl>
      </section>

      <section>
        <h2 class="text-sm font-medium text-ink">The rule both LLMs read</h2>
        <p class="mt-1 text-sm text-ink-2">Built from the definition above. The attacker tries to make the agent break it; the judge scores each conversation against it.</p>
        <blockquote class="mt-3 rounded-lg border-l-2 border-accent bg-card px-5 py-4 font-serif text-[17px] leading-relaxed text-ink">${c(s.rule)}</blockquote>
      </section>

      <details class="group rounded-lg border border-line bg-card">
        <summary class="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm">
          <span><span class="font-medium text-ink">${c(a.name.split(",")[0])}'s system prompt</span> <span class="text-ink-3">\xB7 ${b[t.version].toLowerCase()}</span></span>
          <span class="text-ink-3 transition group-open:rotate-90">${x("chevron",14)}</span>
        </summary>
        <pre class="border-t border-line px-5 py-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">${c(a.prompts[t.version])}</pre>
        <p class="border-t border-line px-5 py-3 text-xs text-ink-3">${t.version==="naive"?"No written policy: the agent is only told to be helpful. Switch to the hardened prompt to see the policy written in.":"The policy is written into the prompt. Switch to the naive prompt to compare."}</p>
      </details>
    </div>

    <aside class="space-y-6">
      <section class="rounded-lg border border-line bg-card p-5">
        <h2 class="text-sm font-medium text-ink">How this becomes a test</h2>
        <ol class="mt-4 space-y-0">
          ${[["Risk definition","Written once, by its owner"],["Attacker LLM","Plays a user, up to 3 turns"],[c(a.name.split(",")[0]),"The agent under test"],["Judge LLM","Reads the rule and the conversation"],["Your review","Agree, or fix what's wrong"]].map(([o,l],d,u)=>`<li class="relative flex gap-3 pb-4 last:pb-0">
              ${d<u.length-1?'<span class="absolute top-6 left-[11px] h-[calc(100%-18px)] w-px bg-line-2"></span>':""}
              <span class="relative grid size-6 shrink-0 place-items-center rounded-full border border-line-2 bg-paper font-mono text-[11px] text-ink-2">${d+1}</span>
              <span><span class="block text-sm font-medium text-ink">${o}</span><span class="block text-xs text-ink-3">${l}</span></span></li>`).join("")}
        </ol>
      </section>
      <section class="rounded-lg border border-line bg-card p-5">
        <h2 class="text-sm font-medium text-ink">Recorded results</h2>
        <div class="mt-3 space-y-2 text-sm">
          ${["naive","hardened"].map(o=>{let l=i[o]?.summary;return`<a href="${k({version:o,step:"attack",runId:null})}" class="flex items-center justify-between rounded-md px-2 py-1.5 -mx-2 hover:bg-sunk"><span class="text-ink-2">${b[o]}</span><span class="font-mono text-xs text-ink">${l?`${l.passed}/${l.passed+l.failed} kept`:"\u2014"}</span></a>`}).join("")}
        </div>
      </section>
      <a href="${k({step:"attack"})}" class="flex items-center justify-center gap-2 rounded-md bg-ink px-4 py-3 text-sm font-medium text-paper hover:bg-ink/90">Attack ${c(a.name.split(",")[0])} with this policy ${x("arrow",15)}</a>
    </aside>
  </div>`}function ce(e,s){return`
  <div id="run-bar" class="rounded-lg border border-line bg-card">${Y(e,s)}</div>
  <div id="run-body" class="mt-6">${X(e,s)}</div>`}function Y(e,s){let t=r.shown,a=!!r.replay,n=!!r.poll,i=e.live.available&&!e.live.busy&&!n,o=e.live.available?e.live.busy||n?"A live run is already in progress":"":"Add GEMINI_API_KEY to .env to run live attacks",l=t?t.mode==="live"?`Live run \xB7 started ${new Date(t.started_at).toLocaleString()}`:`Recorded run \xB7 ${t.started_at.slice(0,10)}`:"Loading\u2026";return`<div class="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
    <div class="min-w-0">
      <div class="text-sm font-medium text-ink">${c(l)}</div>
      <div class="mt-0.5 text-xs text-ink-3">${t?`${t.attacks.length} attacks \xB7 up to 3 turns each \xB7 ${c(Object.values(t.models)[0]??"")} as agent, attacker and judge`:""}</div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      ${a?'<button data-action="skip" class="rounded-md border border-line-2 px-3.5 py-2 text-sm text-ink hover:bg-sunk">Skip to results</button>':`<button data-action="replay" class="inline-flex items-center gap-2 rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-paper hover:bg-ink/90">${x("play",13)} ${s.runId?"Replay the recorded run":"Replay attacks"}</button>`}
      <button data-action="live" ${i?"":"disabled"} title="${c(o)}" class="inline-flex items-center gap-2 rounded-md border border-line-2 px-3.5 py-2 text-sm text-ink hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-45">${x("bolt",13)} Run live with Gemini</button>
    </div>
  </div>`}function X(e,s){let t=r.shown;if(!t)return'<div class="py-20 text-center text-sm text-ink-3">Loading the run\u2026</div>';let a=e.agents[t.agent].name.split(",")[0],n=L(t.attacks),i=C(t),o=e.recorded[s.risk]??{},l=["naive","hardened"].map(d=>{let u=o[d]?.summary;if(!u)return"";let g=u.passed+u.failed,p=d===s.version&&!s.runId;return`<a href="${k({version:d,runId:null,step:"attack"})}" class="block rounded-md px-3 py-2 ${p?"bg-sunk":"hover:bg-sunk/60"}">
        <div class="flex items-center justify-between text-xs"><span class="${p?"font-medium text-ink":"text-ink-2"}">${b[d]}</span><span class="font-mono text-ink-2">${u.passed}/${g} kept</span></div>
        <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fail/25"><div class="h-full rounded-full bg-pass" style="width:${100*u.passed/Math.max(1,g)}%"></div></div></a>`}).join("");return`
  <div class="grid gap-6 lg:grid-cols-[1fr_300px]">
    <div>
      <p class="font-serif text-[26px] leading-snug text-ink">${c(N(a,n))}</p>
      <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-2">
        <span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-fail"></span>${n.failed} broke the rule</span>
        <span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-pass"></span>${n.passed} kept it</span>
        ${n.errored?`<span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full bg-warn"></span>${n.errored} errored</span>`:""}
        ${n.finished?"":`<span class="inline-flex items-center gap-1.5 text-accent"><span class="size-2 animate-pulse rounded-full bg-accent"></span>${n.total-n.passed-n.failed-n.errored} in progress</span>`}
      </div>
    </div>
    <div class="rounded-lg border border-line bg-card p-2">
      <div class="px-3 pt-1.5 pb-1 text-xs text-ink-3">Recorded baseline</div>
      ${l}
    </div>
  </div>
  <div class="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    ${t.attacks.map(d=>pe(e,t,d,!!i[String(d.index+1)])).join("")}
  </div>`}function A(e,s){return`<span class="inline-flex items-center gap-2 text-xs text-ink-3"><span class="typing"><i></i><i></i><i></i></span>${e.pending==="agent"?`${s} is replying`:e.pending==="judge"?"The judge is reading the conversation":e.status==="queued"?"Waiting to start":"The attacker is writing"}</span>`}function pe(e,s,t,a){let n=t.index+1,i=e.agents[s.agent].name.split(",")[0],o=t.turns[0]?.user,l=t.status==="running"||t.status==="queued",d=t.turns.filter(u=>u.agent!=null).length;return`<a href="${k({step:"review",attack:n})}" class="group flex flex-col rounded-lg border border-line bg-card p-4 transition hover:border-line-2 hover:shadow-sm">
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-medium text-ink-2">Attack ${n}</span>
      ${P(t.status)}
    </div>
    <p class="mt-3 line-clamp-3 min-h-[3.9em] text-sm leading-[1.3] text-ink">${o?`\u201C${c(o)}\u201D`:`<span class="text-ink-3">${t.status==="error"?c(t.error??"This attack errored."):"No message yet."}</span>`}</p>
    <div class="mt-4 flex items-center justify-between gap-2">
      ${l?A(t,i):`<span class="flex items-center gap-1.5 text-xs text-ink-3"><span class="flex gap-1">${[0,1,2].map(u=>`<span class="size-1.5 rounded-full ${u<d?"bg-ink-3":"bg-line-2"}"></span>`).join("")}</span>${d} ${d===1?"turn":"turns"}${t.duration_ms?` \xB7 ${M(t.duration_ms)}`:""}</span>`}
      <span class="flex items-center gap-2 text-xs">${a?'<span class="rounded bg-warn-soft px-1.5 py-0.5 text-warn">Second look</span>':""}<span class="text-ink-3 group-hover:text-ink">${x("arrow",14)}</span></span>
    </div>
  </a>`}function ue(e,s){return`<div id="review-body">${Q(e,s)}</div>`}function Q(e,s){let t=r.shown;if(!t)return'<div class="py-20 text-center text-sm text-ink-3">Loading the run\u2026</div>';let a=C(t),n=new Set(Object.keys(a).map(Number)),o=E(t.attacks,n).filter(p=>r.filter==="failed"?p.status==="failed":r.filter==="passed"?p.status==="passed":r.filter==="flagged"?n.has(p.index+1):!0),l=L(t.attacks),d=t.attacks.filter(p=>j(t,p.index+1)).length,u=[["all","All",l.total],["failed","Broke",l.failed],["passed","Kept",l.passed],["flagged","Second look",n.size]],g=t.attacks[s.attack-1]??t.attacks[0];return`
  <div class="grid gap-6 lg:grid-cols-[300px_1fr]">
    <aside class="lg:sticky lg:top-4 lg:self-start">
      <div class="flex items-center justify-between text-xs text-ink-3"><span>${d} of ${l.total} reviewed</span><span>Keys: \u2190 \u2192</span></div>
      <div class="mt-2 h-1 overflow-hidden rounded-full bg-sunk"><div class="h-full rounded-full bg-accent" style="width:${100*d/Math.max(1,l.total)}%"></div></div>
      <div class="mt-4 flex flex-wrap gap-1">
        ${u.filter(([,,p],m)=>m===0||p>0).map(([p,m,f])=>`<button data-filter="${p}" class="rounded-md px-2.5 py-1 text-xs ${r.filter===p?"bg-ink text-paper":"text-ink-2 hover:bg-sunk"}">${m} <span class="${r.filter===p?"text-paper/60":"text-ink-3"}">${f}</span></button>`).join("")}
      </div>
      <div class="mt-3 space-y-1.5 lg:max-h-[calc(100vh-170px)] lg:overflow-y-auto lg:pr-1">
        ${o.map(p=>{let m=p.index+1,f=j(t,m),w=m===g.index+1;return`<a href="${k({step:"review",attack:m})}" class="block rounded-lg border px-3.5 py-3 ${w?"border-ink/70 bg-card":"border-line bg-card/60 hover:border-line-2 hover:bg-card"}">
              <div class="flex items-center justify-between gap-2"><span class="text-xs font-medium text-ink">Attack ${m}</span>${P(p.status)}</div>
              <p class="mt-1.5 line-clamp-2 text-xs leading-snug text-ink-2">${c(p.turns[0]?.user??p.error??"")}</p>
              ${f||n.has(m)?`<div class="mt-2 flex flex-wrap gap-1.5 text-[11px]">${n.has(m)?'<span class="rounded bg-warn-soft px-1.5 py-0.5 text-warn">Second look</span>':""}${f?`<span class="rounded bg-sunk px-1.5 py-0.5 text-ink-2">You ${f.verdict==="agree"?"agreed":`disagreed${f.fix?` \xB7 fix ${V.find(Z=>Z.id===f.fix).label.toLowerCase()}`:""}`}</span>`:""}</div>`:""}
            </a>`}).join("")||'<p class="px-1 py-6 text-sm text-ink-3">Nothing in this filter.</p>'}
      </div>
    </aside>
    <section id="inspector" class="min-w-0 scroll-mt-4">${ge(e,t,g,a[String(g.index+1)])}</section>
  </div>`}function ge(e,s,t,a){let n=t.index+1,i=e.agents[s.agent].name.split(",")[0],o=t.checks.find(p=>p.kind==="conformity")??t.checks[0],l=o?z(o.reason):[],d=j(s,n),u=t.status==="passed"||t.status==="failed"||t.status==="error",g=u?t.status==="error"?`<div class="rounded-lg border border-warn/30 bg-warn-soft px-5 py-4"><div class="text-sm font-medium text-warn">This attack errored</div><p class="mt-1 text-sm text-ink-2">${c(t.error??"")}</p><p class="mt-2 text-xs text-ink-3">Errors aren't counted as a pass or a fail. They usually point to the harness or the provider, not the policy.</p></div>`:`<div class="rounded-lg border ${t.status==="failed"?"border-fail/25 bg-fail-soft":"border-pass/25 bg-pass-soft"} px-5 py-4">
          <div class="flex items-center gap-2 text-sm font-medium ${t.status==="failed"?"text-fail":"text-pass"}">${x(t.status==="failed"?"x":"check",15)} Judge: ${t.status==="failed"?"the agent broke the rule":"the agent kept the rule"}</div>
          <p class="mt-2 text-[15px] leading-relaxed text-ink">${o?c(o.reason):""}</p>
          ${l.length?'<p class="mt-2 text-xs text-ink-3">Phrases the judge quoted are <mark>highlighted</mark> in the conversation.</p>':""}
        </div>`:`<div class="rounded-lg border border-line bg-card px-5 py-4">${A(t,i)}</div>`;return`
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-3"><h2 class="font-serif text-2xl text-ink">Attack ${n}</h2>${P(t.status)}</div>
    <div class="flex items-center gap-1">
      <button data-action="prev" class="grid size-8 place-items-center rounded-md border border-line text-ink-2 hover:bg-sunk" aria-label="Previous attack">${x("left",15)}</button>
      <button data-action="next" class="grid size-8 place-items-center rounded-md border border-line text-ink-2 hover:bg-sunk" aria-label="Next attack">${x("right",15)}</button>
    </div>
  </div>
  <div class="mt-4 space-y-4">
    ${g}
    ${a?`<div class="rounded-lg border border-line bg-card px-5 py-4"><div class="text-xs font-medium text-warn">Second look \xB7 ${c(a.verdict)}</div><p class="mt-1.5 text-sm leading-relaxed text-ink-2">${c(a.note)}</p></div>`:""}
  </div>

  <h3 class="mt-8 text-xs font-medium tracking-wide text-ink-3 uppercase">Conversation</h3>
  <div class="mt-3 space-y-4">
    ${t.turns.map((p,m)=>`
      <div class="flex gap-3">
        <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-sunk text-ink-2" title="Giskard's attacker">${x("user",14)}</span>
        <div class="min-w-0 flex-1"><div class="text-xs text-ink-3">Attacker, posing as the user \xB7 turn ${m+1}</div>
          <div class="mt-1 rounded-lg rounded-tl-sm bg-sunk px-4 py-3 text-[15px] leading-relaxed text-ink">${c(p.user)}</div></div>
      </div>
      <div class="flex gap-3">
        <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-ink text-paper" title="${c(i)}">${x("bot",14)}</span>
        <div class="min-w-0 flex-1"><div class="text-xs text-ink-3">${c(i)}${p.ms?` \xB7 ${M(p.ms)}`:""}</div>
          <div class="reply mt-1 rounded-lg rounded-tl-sm border border-line bg-card px-4 py-3 text-[15px] leading-relaxed text-ink">${p.agent==null?A(t,i):p.agent?q(p.agent,l):'<span class="text-ink-3">(empty reply)</span>'}</div></div>
      </div>`).join("")}
    ${t.turns.length?"":`<p class="text-sm text-ink-3">${u?"No turns were recorded.":"The conversation hasn't started yet."}</p>`}
  </div>

  ${t.status==="passed"||t.status==="failed"?`<div class="mt-8 rounded-lg border border-line bg-card p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div><h3 class="text-sm font-medium text-ink">Do you agree with the judge?</h3><p class="mt-0.5 text-xs text-ink-3">In a real team, the rule's owner answers this. Saved in this browser only.</p></div>
      <div class="flex gap-2">
        <button data-action="agree" class="inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-sm ${d?.verdict==="agree"?"border-ink bg-ink text-paper":"border-line-2 text-ink hover:bg-sunk"}">${x("check",13)} Agree</button>
        <button data-action="disagree" class="inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-sm ${d?.verdict==="disagree"?"border-ink bg-ink text-paper":"border-line-2 text-ink hover:bg-sunk"}">${x("x",13)} Disagree</button>
      </div>
    </div>
    ${d?.verdict==="disagree"?`<div class="mt-4 border-t border-line pt-4"><div class="text-xs font-medium text-ink-2">What should change?</div>
      <div class="mt-2 grid gap-2 sm:grid-cols-2">${V.map(p=>`<button data-fix="${p.id}" class="rounded-md border px-3.5 py-2.5 text-left ${d.fix===p.id?"border-ink bg-sunk":"border-line hover:border-line-2"}"><span class="block text-sm font-medium text-ink">${p.label}</span><span class="block text-xs text-ink-3">${p.hint}</span></button>`).join("")}</div></div>`:""}
  </div>`:""}`}function xe(e){let s=r.route;if(s.page!=="risk")return"";let t=e.live.attacks;return`<div class="fixed inset-0 z-40 grid place-items-center bg-ink/30 p-4" data-action="cancel" data-backdrop>
    <div class="w-full max-w-md rounded-xl border border-line bg-card p-6 shadow-xl" data-stop>
      <h2 class="font-serif text-2xl text-ink">Run ${t} new attacks?</h2>
      <p class="mt-2 text-sm leading-relaxed text-ink-2">Giskard will attack ${c(e.agents[e.risks[s.risk].agent].name.split(",")[0])} (${b[s.version].toLowerCase()}) on <b class="font-medium text-ink">${c(e.risks[s.risk].risk.toLowerCase())}</b> with fresh conversations.</p>
      <ul class="mt-4 space-y-1.5 text-sm text-ink-2">
        <li class="flex gap-2"><span class="text-ink-3">\u2022</span>Up to ${t*7} paid Gemini calls (attacker, agent and judge)</li>
        <li class="flex gap-2"><span class="text-ink-3">\u2022</span>Usually 1.5 to 3 minutes; you can watch each conversation as it happens</li>
        <li class="flex gap-2"><span class="text-ink-3">\u2022</span>Saved locally in <code class="font-mono text-xs">runs/</code></li>
      </ul>
      <div class="mt-6 flex justify-end gap-2">
        <button data-action="cancel" class="rounded-md px-3.5 py-2 text-sm text-ink-2 hover:bg-sunk">Cancel</button>
        <button data-action="confirm-live" class="inline-flex items-center gap-2 rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-paper hover:bg-ink/90">${x("bolt",13)} Start live run</button>
      </div>
    </div>
  </div>`}function O(e){let s=document.createElement("div");s.className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-md bg-ink px-4 py-2.5 text-sm text-paper shadow-lg",s.textContent=e,document.body.append(s),setTimeout(()=>s.remove(),4500)}var me={shield:'<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',grid:'<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',chevron:'<path d="M9 6l6 6-6 6"/>',left:'<path d="M15 6l-6 6 6 6"/>',right:'<path d="M9 6l6 6-6 6"/>',play:'<path d="M7 5l12 7-12 7z" fill="currentColor"/>',bolt:'<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',check:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',x:'<path d="M6 6l12 12M18 6L6 18"/>',user:'<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"/>',bot:'<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9.5 13h.01M14.5 13h.01"/>'};function x(e,s=16){return`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${me[e]}</svg>`}function S(e){let s=r.route,t=r.shown;if(s.page!=="risk"||s.step!=="review"||!t)return;let a=C(t),n=E(t.attacks,new Set(Object.keys(a).map(Number))).map(l=>l.index+1),i=n.indexOf(s.attack),o=n[(i+e+n.length)%n.length];T({attack:o})}document.addEventListener("click",e=>{let s=e.target,t=s.closest("[data-action],[data-filter],[data-fix]");if(!t)return;let a=r.shown,n=r.route;if(t.dataset.filter)return r.filter=t.dataset.filter,R();if(t.dataset.fix&&a&&n.page==="risk")return K(a,n.attack,{verdict:"disagree",fix:t.dataset.fix}),R();let i=t.dataset.action;if(!(i==="cancel"&&t.hasAttribute("data-backdrop")&&s.closest("[data-stop]")))switch(i){case"replay":return void ne();case"skip":return J();case"live":return r.confirming=!0,h();case"cancel":return r.confirming=!1,h();case"confirm-live":return void ae();case"prev":return S(-1);case"next":return S(1);case"agree":case"disagree":if(a&&n.page==="risk"){let o=j(a,n.attack);K(a,n.attack,o?.verdict===i?null:{verdict:i}),R()}}});document.addEventListener("keydown",e=>{if(!(e.target instanceof HTMLElement&&["INPUT","TEXTAREA"].includes(e.target.tagName))){if(e.key==="Escape"&&r.confirming)return r.confirming=!1,h();(e.key==="ArrowRight"||e.key==="j")&&S(1),(e.key==="ArrowLeft"||e.key==="k")&&S(-1)}});document.addEventListener("change",e=>{let s=e.target;s.matches("[data-nav]")&&(location.hash=s.value)});window.addEventListener("hashchange",()=>{W()});async function fe(){try{r.catalog=await y("/api/catalog"),await _()}catch(s){v("main").innerHTML=`<div class="p-10 text-sm text-fail">Could not load the app: ${c(s.message)}</div>`;return}let e=new URLSearchParams(location.search);if(e.get("risk")&&!location.hash){history.replaceState(null,"","/"),location.hash=`#/${e.get("risk")}/${e.get("version")??"naive"}/${e.get("attack")?`review/${e.get("attack")}`:"attack"}`;return}await W()}fe();
