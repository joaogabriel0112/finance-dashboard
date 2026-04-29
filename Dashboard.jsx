import { useState, useEffect, useRef, useMemo } from "react";
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area, ComposedChart, Line } from "recharts";
import { TrendingUp, TrendingDown, DollarSign, Target, CreditCard, AlertTriangle, PiggyBank, Wallet, BarChart3, ArrowUpRight, ArrowDownRight, Edit3, Check, Bell, Shield, Activity, Landmark, RotateCcw, CheckCircle, Download, Plus, Trash2, X, Search, Calendar, Filter, ChevronLeft, ChevronRight, ChevronDown, Copy, Upload, Sun, Moon, Heart, Repeat, Zap, Cloud, CloudOff, RefreshCw, LogIn, LogOut, User } from "lucide-react";
import { createClient } from "@supabase/supabase-js";

// =====================================================
// CLOUD SYNC v18 — Supabase + Google OAuth + GitHub Pages cache fix
// =====================================================
//
// PASSO 1, instale a dependencia no seu projeto:
//   npm install @supabase/supabase-js
//
// PASSO 2, preencha as 2 constantes abaixo com as credenciais
// do seu projeto Supabase (Settings > API).
//
// PASSO 3, rode supabase-setup.sql no SQL Editor do Supabase.
//
// PASSO 4, ative o provider Google em Authentication > Providers
// (instrucoes detalhadas no README-CLOUD-SETUP.md).
// =====================================================

const SUPABASE_URL = "https://xtndwkczzowmuarjjmzq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_KQVJEoQ6QBVYq6O78PQV_A_4zKmbY5R";

// Detecta se as credenciais foram configuradas (aceita anon JWT legado e sb_publishable novo)
const CLOUD_ENABLED = SUPABASE_URL.indexOf("supabase.co") > -1 && SUPABASE_ANON_KEY.length > 20 && SUPABASE_ANON_KEY.indexOf("COLE_AQUI") === -1;

// Cliente unico
let supabase = null;
if (CLOUD_ENABLED) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "vault_auth", flowType: "pkce" }
    });
  } catch (e) { console.warn("[cloud] supabase init falhou", e); }
}

// Identificador unico do device (rastrear quem foi a ultima escrita)
function getDeviceId() {
  try {
    var k = "vault_device_id";
    var d = localStorage.getItem(k);
    if (!d) {
      d = (navigator.userAgent.match(/Chrome|Firefox|Safari|Edge/) || ["Browser"])[0]
        + "_" + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(k, d);
    }
    return d;
  } catch (e) { return "unknown"; }
}
const DEVICE_ID = (typeof window !== "undefined") ? getDeviceId() : "ssr";

// Cloud helpers (todos retornam Promise)
const cloud = {
  available: function() { return CLOUD_ENABLED && !!supabase; },

  getSession: function() {
    if (!cloud.available()) return Promise.resolve(null);
    return supabase.auth.getSession().then(function(r) { return r.data && r.data.session ? r.data.session : null; });
  },

  signInGoogle: function() {
    if (!cloud.available()) return Promise.reject(new Error("Supabase nao configurado"));
    var redirectTo = window.location.origin + window.location.pathname;
    return supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo } });
  },

  signOut: function() {
    if (!cloud.available()) return Promise.resolve();
    return supabase.auth.signOut();
  },

  load: function(userId) {
    if (!cloud.available() || !userId) return Promise.resolve(null);
    return supabase.from("vault_data").select("data, version, updated_at, device").eq("user_id", userId).maybeSingle()
      .then(function(r) {
        if (r.error) throw r.error;
        return r.data || null;
      });
  },

  save: function(userId, data) {
    if (!cloud.available() || !userId) return Promise.reject(new Error("offline"));
    var payload = {
      user_id: userId,
      data: data,
      version: (data && data.v) || 1,
      device: DEVICE_ID,
      updated_at: new Date().toISOString()
    };
    return supabase.from("vault_data").upsert(payload, { onConflict: "user_id" }).select().single();
  },

  subscribe: function(userId, onChange) {
    if (!cloud.available() || !userId) return function() {};
    var ch = supabase.channel("vault:" + userId)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "vault_data", filter: "user_id=eq." + userId },
        function(payload) {
          var newRow = payload["new"];
          if (newRow && newRow.device !== DEVICE_ID) {
            try { onChange(newRow); } catch (e) {}
          }
        })
      .subscribe();
    return function() { try { supabase.removeChannel(ch); } catch (e) {} };
  },

  audit: function(userId, action, kb) {
    if (!cloud.available() || !userId) return Promise.resolve();
    return supabase.from("vault_audit").insert({ user_id: userId, action: action, device: DEVICE_ID, payload_kb: kb || 0 })
      .then(function() {})["catch"](function() {});
  }
};

// Hook React: gerencia sessao, status de sync, sync inicial e realtime
function useCloudSync(localDb, applyRemoteDb, doLocalSave) {
  var _user = useState(null); var user = _user[0]; var setUser = _user[1];
  var _status = useState(CLOUD_ENABLED ? "connecting" : "disabled");
  var status = _status[0]; var setStatus = _status[1];
  // status: disabled | connecting | offline | signed_out | syncing | synced | error
  var _lastSync = useState(null); var lastSync = _lastSync[0]; var setLastSync = _lastSync[1];
  var pendingTimer = useRef(null);
  var lastLocalRef = useRef(null);
  var unsubRef = useRef(null);

  // Inicializacao: pega sessao + listener
  useEffect(function() {
    if (!cloud.available()) { setStatus("disabled"); return; }
    cloud.getSession().then(function(s) {
      if (s && s.user) {
        setUser(s.user);
        setStatus("syncing");
        // Pull inicial
        cloud.load(s.user.id).then(function(remote) {
          if (remote && remote.data) {
            try { applyRemoteDb(remote.data, remote.updated_at); } catch (e) {}
          } else {
            // primeira vez no Supabase, sobe o localStorage atual
            if (localDb) cloud.save(s.user.id, localDb)["catch"](function() {});
          }
          setStatus("synced");
          setLastSync(new Date());
        })["catch"](function() { setStatus("error"); });
      } else {
        setStatus("signed_out");
      }
    });
    var listener = supabase.auth.onAuthStateChange(function(event, session) {
      if (session && session.user) {
        setUser(session.user);
        setStatus("syncing");
        cloud.load(session.user.id).then(function(remote) {
          if (remote && remote.data) {
            try { applyRemoteDb(remote.data, remote.updated_at); } catch (e) {}
          }
          setStatus("synced");
          setLastSync(new Date());
        });
      } else {
        setUser(null);
        setStatus("signed_out");
        if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
      }
    });
    return function() {
      try { listener.data.subscription.unsubscribe(); } catch (e) {}
      if (unsubRef.current) unsubRef.current();
    };
  }, []);

  // Realtime: escuta mudancas vindas de outros devices
  useEffect(function() {
    if (!user) return;
    if (unsubRef.current) unsubRef.current();
    unsubRef.current = cloud.subscribe(user.id, function(row) {
      if (row && row.data) {
        try { applyRemoteDb(row.data, row.updated_at); setLastSync(new Date()); } catch (e) {}
      }
    });
    return function() { if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; } };
  }, [user && user.id]);

  // Push debounced quando localDb muda
  useEffect(function() {
    if (!user || status === "disabled" || !localDb) return;
    if (lastLocalRef.current === localDb) return;
    lastLocalRef.current = localDb;
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    setStatus("syncing");
    pendingTimer.current = setTimeout(function() {
      cloud.save(user.id, localDb).then(function() {
        setStatus("synced");
        setLastSync(new Date());
        try {
          var kb = Math.round(JSON.stringify(localDb).length / 1024);
          cloud.audit(user.id, "save", kb);
        } catch (e) {}
      })["catch"](function() { setStatus("error"); });
    }, 800);
    return function() { if (pendingTimer.current) clearTimeout(pendingTimer.current); };
  }, [localDb, user && user.id]);

  // Detecta online/offline
  useEffect(function() {
    function onOff() {
      if (!navigator.onLine) setStatus("offline");
      else if (user) setStatus("synced");
    }
    window.addEventListener("online", onOff);
    window.addEventListener("offline", onOff);
    return function() {
      window.removeEventListener("online", onOff);
      window.removeEventListener("offline", onOff);
    };
  }, [user]);

  return {
    user: user,
    status: status,
    lastSync: lastSync,
    signIn: function() { return cloud.signInGoogle(); },
    signOut: function() { return cloud.signOut(); },
    forceSync: function() {
      if (!user || !localDb) return Promise.resolve();
      setStatus("syncing");
      return cloud.save(user.id, localDb).then(function() {
        setStatus("synced");
        setLastSync(new Date());
      });
    }
  };
}
// =====================================================

const T_DARK = { bg:"#04050C", surface:"#080814", card:"#0A0E1C", cardAlt:"#0E1224", border:"rgba(0,245,212,0.12)", text:"#EAF2FF", muted:"#93A3BC", dim:"#5B6A85", green:"#A8FF3E", greenL:"#00F5D4", gold:"#FFB800", amber:"#FFB800", red:"#FF5A1F", ruby:"#FF5A1F", blue:"#00C2FF", bluePremium:"#00C2FF", purple:"#7B4CFF", cyan:"#00F5D4", pink:"#FF00E5", holo:"#FF00E5", neon:"#00F5D4", orange:"#FF5A1F", sky:"#00C2FF", steel:"#5B6A85", emerald:"#A8FF3E", whiteA:"rgba(255,255,255,0.04)", whiteB:"rgba(255,255,255,0.08)", glass:"rgba(10,14,28,0.65)", shadow:"0 24px 60px -24px rgba(0,194,255,0.18)", gridLine:"rgba(0,194,255,0.05)" };
const T_LIGHT = { bg:"#F4F6FA", surface:"#FFFFFF", card:"#FFFFFF", cardAlt:"#F0F2F8", border:"rgba(0,0,0,0.08)", text:"#1A1A2E", muted:"#5A6478", dim:"#9AA0B0", green:"#00B864", greenL:"#00D474", gold:"#E6A800", amber:"#E68A00", red:"#E02040", ruby:"#D01040", blue:"#0088DD", bluePremium:"#009EF0", purple:"#8838EE", cyan:"#00A8CC", pink:"#E0308A", holo:"#C2007A", neon:"#00A8CC", orange:"#E06800", sky:"#00A8CC", steel:"#8A94A6", emerald:"#00B864", whiteA:"rgba(0,0,0,0.02)", whiteB:"rgba(0,0,0,0.04)", glass:"rgba(255,255,255,0.55)", shadow:"0 2px 12px rgba(0,0,0,0.08)", gridLine:"rgba(0,168,204,0.06)" };
let T = T_DARK;
let PC = [T.green,T.blue,T.gold,T.purple,T.cyan,T.orange,T.orange,"#FF6B6B",T.greenL,"#00AAFF"];
const MS = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
const MSF = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const VER = 15;
const SK = "findash8";
const BACKUP_SLOTS = 3;
// === DESIGN TOKENS v16 FUTURISTIC ===
const SP = { xs:4, sm:8, md:12, lg:16, xl:24, xxl:32, xxxl:48 };
const FS = { mono:11, xs:13, sm:15, md:20, lg:32, hero:48 };
const RD = { sm:6, md:10, lg:14, xl:20, pill:999 };
const FF = { sans:"'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif", mono:"'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', monospace" };
const GLOW = (color, intensity=0.3) => `0 0 24px ${color}${Math.round(intensity*255).toString(16).padStart(2,'0')}, inset 0 1px 0 rgba(255,255,255,0.06)`;
const GLOW_STRONG = (color) => `0 0 32px ${color}40, 0 0 64px ${color}20, inset 0 1px 0 rgba(255,255,255,0.08)`;
const NEON_BORDER = (color, alpha=0.4) => `1px solid ${color}${Math.round(alpha*255).toString(16).padStart(2,'0')}`;
const TOP_LINE = (color) => ({ position:'absolute', top:0, left:0, right:0, height:1, background:`linear-gradient(90deg, transparent, ${color}, transparent)`, pointerEvents:'none' });
const MONO_LABEL = { fontFamily:FF.mono, fontSize:10, letterSpacing:'1.5px', textTransform:'uppercase', color:'#5B6A85' };
const MONO_VALUE = { fontFamily:FF.mono, letterSpacing:'-0.3px' };
const FRASES = [
"Cada real investido hoje é liberdade amanhã.",
"Disciplina financeira constrói tranquilidade.",
"Pequenos aportes consistentes constroem fortunas.",
"O melhor momento para investir é agora.",
"Sua liberdade financeira está perto.",
"Juros compostos trabalham por você.",
"Riqueza é o que você não gastou.",
"Invista no que te deixa dormir tranquilo.",
"Paciência é o ingrediente secreto dos milionários.",
"Seu eu do futuro agradece cada aporte de hoje.",
"Consistência vence intensidade no longo prazo.",
"Dinheiro parado é dinheiro perdendo valor.",
"Cada meta atingida é um degrau para a liberdade.",
"Não é sobre quanto você ganha, é sobre quanto você guarda.",
"A magia dos juros compostos precisa apenas de tempo.",
"Construa patrimônio enquanto outros constroem dívidas.",
"O hábito de investir importa mais que o valor.",
"Liberdade financeira se conquista um mês de cada vez.",
"Quem poupa hoje colhe independência amanhã.",
"Sua disciplina de hoje define seu padrão de vida amanhã.",
"Investir é plantar árvores cuja sombra você ainda vai precisar.",
"O tempo no mercado vence o timing do mercado.",
"Patrimônio se constrói em silêncio.",
"Cada R$ 100 investido vira R$ 200 com paciência.",
"A independência financeira é um estilo de vida, não um destino.",
"Metas claras transformam sonhos em planos.",
"O primeiro milhão é o mais difícil. Comece agora.",
"Dinheiro investido é soldado trabalhando por você 24h.",
"Aporte mensal é compromisso com o seu futuro.",
"Enriquecer é um processo, não um evento.",
"Proteja seu patrimônio como protege sua saúde.",
"Rentabilidade vem da disciplina, não da sorte.",
"O melhor investimento é aquele que você mantém.",
"Sua reserva de emergência é seu escudo contra o caos.",
"Cada mês sem dívida é um mês de liberdade.",
"Faça seu dinheiro trabalhar enquanto você dorme.",
"Metas financeiras são promessas que você faz a si mesmo.",
"O caminho para R$ 100 mil começa com o primeiro aporte.",
"Pense em décadas, não em dias.",
"Quem investe com constância nunca se arrepende.",
"Sua conta de investimentos é seu segundo salário em construção.",
"Aportar é cuidar de quem você será daqui a 10 anos.",
"O segredo não é ganhar mais, é administrar melhor.",
"Patrimônio sólido se constrói com decisões simples e repetidas.",
"Invista primeiro, gaste o que sobrar.",
"A melhor hora para começar foi ontem. A segunda melhor é agora.",
"Foque no processo, os resultados virão.",
"Cada meta batida prova que você é capaz da próxima.",
"O dinheiro é um ótimo servo, mas um péssimo mestre.",
"Sua jornada financeira é única. Compare-se apenas com quem você era ontem."
];
const FRASES_PARC = [
"Não é o seu salário que te faz rico, é o seu hábito de gastar. — Charles A. Jaffe",
"Cuidado com pequenas despesas: um pequeno vazamento afunda um grande navio. — Benjamin Franklin",
"O preço de qualquer coisa é a quantidade de vida que você troca por ela. — Henry David Thoreau",
"Nunca gaste o seu dinheiro antes de tê-lo. — Thomas Jefferson",
"A dívida é a escravidão do homem livre. — Publilius Syrus",
"Regra nº 1: nunca perca dinheiro. Regra nº 2: nunca esqueça a regra nº 1. — Warren Buffett",
"Quanto mais cedo você começar a trabalhar para diminuir suas dívidas, mais rápido alcançará a paz financeira. — Dave Ramsey",
"Uma pessoa rica não é quem tem mais, mas quem precisa de menos. — Sêneca",
"O investimento em conhecimento sempre paga os melhores juros. — Benjamin Franklin",
"Se você comprar coisas de que não precisa, logo terá de vender coisas de que precisa. — Warren Buffett",
"Riqueza consiste não em ter grandes posses, mas em ter poucas necessidades. — Epicteto",
"O homem que não sabe administrar pouco, não administrará muito. — Robert Kiyosaki",
"Gaste menos do que ganha e invista a diferença. A simplicidade reside nisso. — J.L. Collins",
"Dinheiro é apenas uma ferramenta. Ele te levará aonde quiser, mas não substituirá você como motorista. — Ayn Rand",
"A liberdade financeira está disponível para quem aprende sobre ela e trabalha por ela. — Robert Kiyosaki",
"Não economize o que sobra após gastar; gaste o que sobra após economizar. — Warren Buffett",
"Os juros compostos são a oitava maravilha do mundo. Quem entende, ganha. Quem não entende, paga. — Albert Einstein",
"O caminho para a riqueza depende de duas palavras: trabalho e poupança. — Benjamin Franklin",
"Seu nível de sucesso raramente excede seu nível de desenvolvimento pessoal. — Jim Rohn",
"A maior riqueza é viver contente com pouco. — Platão",
"Pessoas ricas adquirem ativos. Pessoas pobres e de classe média adquirem passivos pensando que são ativos. — Robert Kiyosaki",
"Não se trata de ter tudo, mas de aproveitar tudo que você tem. — Gustavo Cerbasi",
"Um orçamento diz ao dinheiro para onde ir, em vez de perguntar para onde ele foi. — Dave Ramsey",
"O melhor momento para plantar uma árvore foi 20 anos atrás. O segundo melhor momento é agora. — Provérbio chinês",
"Quem vive de aparência morre de realidade. — Gustavo Cerbasi",
"Corte seu casaco de acordo com o tecido que tem. — Provérbio inglês",
"O problema não é o quanto você ganha, é o quanto você gasta. — Will Smith",
"A paciência é amarga, mas seu fruto é doce. — Jean-Jacques Rousseau",
"Investir é transferir poder de compra do presente para o futuro. — Howard Marks",
"A diferença entre quem é rico e quem não é: disciplina. — Tony Robbins",
"Dívida é normal. Seja esquisito. — Dave Ramsey",
"A simplicidade é o último grau de sofisticação. — Leonardo da Vinci",
"Não trabalhe pelo dinheiro; faça o dinheiro trabalhar por você. — Robert Kiyosaki",
"Uma jornada de mil milhas começa com um único passo. — Lao-Tsé",
"O dinheiro que você tem lhe dá liberdade; o dinheiro que você persegue lhe tira. — Jean-Jacques Rousseau",
"Mais importante do que o retorno sobre o investimento é o retorno do investimento. — Will Rogers",
"Toda conquista começa com a decisão de tentar. — John F. Kennedy",
"Controle seus gastos ou eles controlarão você. — John Bogle",
"O sucesso financeiro não é um sprint, é uma maratona. — Suze Orman",
"A riqueza não é fruto de grandes rendas, mas de hábitos inteligentes. — Nathalia Arcuri"
];

const BANK_LOGOS = {
  itau: "data:image/png;base64,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",
  santander: "data:image/png;base64,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",
  bradesco: "data:image/png;base64,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",
  revolut: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAYAAACOEfKtAAAXVklEQVR42u1ceZQU1b3+fvdW9d4zPTO4ACKuwLhgFDWDiAIGl+RFRaOouJxoeL6nxyTGPUqAF5coisaIPs2mJhoe+lyyHI0eZdxyTGJ8RiEYTeLGKjAzvS9V9/7eH1XVXb3MTM9Cnu8cLqfonuruqlvf/S3f77u3CtjZdradbWfb2Xa2YTYazYMxM432MXdAYyLiz0xvVq1aJZnZcMH7f9GYWbh9FiM9ljGCTkgAmoiUb19LX1+hQ0kKExGhBCDg+1FpgAMGmvjOMJrXBWbWRMFMth3biCgPQHtgAgAR6X+KC3tu6p0wmSx1CYNO1lofozX2Y+Y2gAIEgOt/O3hPeIjd5+auyj13AURbhaC/SIkXoMynW1vpPc8g/MawQwBkZuEB15exTjQFXQOiWZGQgK2BUomhbAVmDQZQxou5X1yYgapPeSidb9x9IgK50ZjgvgcghICUEqYJGBJIZ6yiEPRkqVi4pb09/rYXhoYSI8VQXJaI9Ecf9bVl89ZDkZDxTCgkZ9mWzZlsyS7kLaVsi4k0C0GQgiAlQUq4r84+IQBBALmbIECQB8UIYzuxc0zhbFIAUgJCAlKChWBmbet8wVKpjGUDFIxGjLPC4fAfMpnSIiJiIuLFi5uPjTQE8NSnnxYmRePGk5GQPCCZtpQUgBQk+zuKY10+C/T9rdn3N9j5Lg/i5o2sj9yL8F5BEJIgPKtzrZHKryifSzOz1loTCRmNGCiV9NM9PZ8uGDt2bJaZqRlLpGbdtq+P9xWGeikQlOPzOcsKmGQKUeko17gg+2KehwlzNVBlUN33QwbQD55nxdQYNO+9IKqOFszQmllrtiMR0yyV1OpAQH7RzT+DUh7RRMLA1q0ct7T9S8OU47MZyzZNYQohIASBBFU66g1JTadpgGHiYWW+CnjkA698Ll+IqAeyOnyQE2rIMISZy5esQEDOLhatn7ixXow0Bgoi0rmSdVe8xTggm7Es0xSGIF8s81uAv6PwgGsyT7Ev6QzB8uADr5w0BjtGua/kxmPnvSGlWShaVjBonl0sFi8kIuXStaG7sBf3PtxQmhGJGK+yUnbAhGEaBMMgSOGcuJxDudqNucpl+3n1uW2z7ut3VaIKoEDl73rLq97nubif4njn15q1lAJKq95SsTAlHo9vHygzCwziXcWSXmyaBCImIQjCzaQVqkBVQbxidPXnU0rB9m3KVlDKhlKqqU0rBdu2obXydZKbsFyuC9T1Lu5apCBh2UoHA2aHYQQudYGTQ7JAL3Gsea9wQCQi3w6aEKEgKGAKmIZDS4Q/o3mZtvy+cmEVCyNEwrIu9lVb4iDxRDjntG0gmy1CKwVpSMexaSAL9O8nkEADK6xYoq20Ng1BhYL9cTQamAKg2J8VGgPERg3CKa0thiwVLFuQMIQ/29XGr37jGgMg2LaN665bjM1bNsM0TWd/nWFwv+PMYASDIUyYMAHTDj8CRx7ZhURbBMlkHkTC5ZIVAl13SPJZH1O5iCHf4HEl8ItiUelQODAxkyl0xePhbjcWqmYB1M6BcIxmgIQb7prPBz7LYgghYFklrFz5c3z44UcIBAJg5urDNXFsz0pCoSAOOmgqLvv65Thz/hnI5yxord1OoowMM/v2cfkkXr8IhCoJxAckg7UUIKX4WADd/fXQaERdiEjf/8YbJoBJyvJxVH/vGphguXzz+6XPChKJNrS1pRAMBpvme42SiNYaa9a8jQvOPwcvvbQad9xxJ6QhoJV2Rruql074qMRlquyrIO0LN941ONFcgw4eiHH1m0SmxSa1grhDaUb10JVfqk/qMz1G9XdGXKJ5bqG1m0Q0IpEoxowZgwfuvw8Lv3YRpMepdHVcYB9F8A9uOfnUknv3b80gWwNaY6zfKwe1wCVLlhAAlnkZJBMmWNdkPPJZD1WEgJrqoiqouC7T19eH3t7eYVkgESEUCiEUCjkZWWtorTFu3DisXPkIJk+egiVLbkBfMg9JRjnBuUwLnhF6gBI7fWfXArXPGLRmKM2kbIA1hYanB0ZQLtMqpkdlbHwMsKyo+Pkg++xOa4ZhBHDaaWdg0+ZNMM2AC2DFGrzfUYOyhYiQz+ew5p238cEHf0c83lL+zLIsjBkzBvfccxfmzTsdnQdMRj5vQUpRFfrIG1z3+FX7q9zXBVMDSgOKRyKoUr0w4GRPci/WBx5XiwW1WpxhGFh2+23Qbsf8LsbwyqqB3Bfo7e3Ff953L+5cfiuCwZAby5xjb9u2FY888jBuu+0W5HIKzKLCST0L5EocLA8+qOK22u2PBpRmaA1oNQIAHZ5c5Yc+F67JKzXKS11QBiOZzCMSCcMMOJ30XQ9yWYV8oTBg3RwKRbF0yfWwbQu3L7sFbW1tZXcOhcJ45ZWXkMqUIKVR9g9igIncV9Rl5LISpKtUGjC7Fqh5BADWEU3/+bnOivyyVW3ici4ygKeeehLvrluHUCgIzQwigXw+j+OPPwmHfG4qCoUSqB9TtG0byTTh4osvxcpf/Ay9vT0wDIdTBgIBrF+/Hls2b8aECRNQLJYghOspzK4FEsop0R/HdSUGatcS/dvIAWQvhbjmTj4pnWrIdFVGrnZj05T4yY/vx3PP/RbBYBBK2ZDSRLFYQDweR9f0w5DLFcrxq74SEbAshfaOMdh33/3x6qsvIx4PQGsNIQQKhTzS6ZQDnOstXlcdC+QqEKmmYvJin/bcVwNK0/AAjNRRY6oisx4JJfbJ8rWlXI3Gxwy0tLQiFouitTUBpRSkNNDTsw3BULhJNQbQSqFQyEMIUbEi1pBSQkqj6jheJq4G0Yl9aETHKjQGSgO2GoGcRT4GzVydHKpq3Qbg1VI/76e2KwjUbuzSpQoXq9+skoVYPIR3/7oOa9euQTgcdisQR6hIJBLo6NgFlqWrsjlzlSP5and3A9dywLIVMo8wiTQs0djHAgkNwWukMDfD/AKBAAzDbGj/iUQY6VQOi264BoVCHrFYC7RWrvsW0Nl5IHbbrQOZjGOd/lLOb4n+Yqo22TkJxYmJXjwc2bxwOQtXuACzIyiUXbgBeOAGBX0TCG7etMlNLlTlg0pZWLduLe6+6068+eYfEY+3lGUtIoJSNk459XQYsmbQvJrbI9ZuYepPiJXyDWXgPFqjRpZEuKEFEnkMHlUuXZ9I6q2PGnI8RsAMYMuWXnzxpDkolYqQUpYrG3K1xN7eXhhSoqWlBUo54ElpIJVKYdq0IzBv3jwkUyUIIautzP3PGXSuG9wqSQ2o5oQ8QgukBs5ULoecWZcqMcEf/riB9fEApVqpZCGVSpYVHL8lEQGtra1gZh94EpZVhGma+N6tyxGNhJFK5x3wfSejGiD9x+RGIHI9dRs6gGE/D3TVC4+MchWcDXXB+lq3Uq0MVO8ahlGmJbXHUEq5qrGAEBKZTApCSNz/wE9x9NFd6O3NwTBkQxnMbxGE/uNfHbfFSJNILWDlVQZUkY2oMXhVxHtoKyDKW+1+rTUKhQJKpSIOPvgQLLv9LsyaNRO9vTnX7RsXArWyW+NBR/navM/0iFxY+HieVwOTX0igssxWZ3lcQ8J5cOGUmVEqlWAYjbslpYRhmPjcoYfh1FNOx/yzFqA1ES+D19DiMfC06oAUjkZogbUxq0JG3eRMbifLVIHrR7VJqapUKmL33dpx0EFT8ac//QEtLa1VsS6ZTOLss8/Dd2+8CdFoAi0tJpJJC6mk57Y7aMkfjZRIU/V8Qr1YiSp34xqXQO2sGTc+j1IK4ZCBZbffjXi8BZZllamM1hrRaBTPPPMrfPzxeoRCBrZsSYFZQUpRJsAjmbzv7/eDTpwPkEMGnDxqlKm4jvtxYz7YqCNSomgBh007BEuW3uLWtLI8QA5dSeKSf78IyWQS4fAQRNkduB51UAts7Mj9AeZfYcANrHHgJiWwfXsKF33tQsyffy56eraV46HWCi0trViz5h0sWnQ9YrEgtG5+TSTvAPdtxkKr6uFq6Z7hX1UFf11c47ZDycKO+lzCzd9bhv0nTUE2my2LBrZto6OjAw89+CM88shKtLdHYdt20yDxP9sCBVWnU26wlsWT5usAbbDepZkLEIJQLFjYdbcxuOOOH5RVZ7+uGI1Gcf23r8S6dX9DNBpuzhK5Svvtv088mi5ca8X9rDStVp6r51fLys0QeiYNib7eDOaeMAuXf+ta9PT0lF3ZEU+D2L59O751+WVgdpUXL4mNokvTqMRAqjki96Ng1Exxsu/fcJphSPT25HHlVVdjznFz0dfX50r1gFI2EokEXnzxeSxbdhva28OwlRq0XKyT2JoAlYYNYARVa/DgV1xqCSt8utoIQKvtOruS/x3Lf4COjjEolYplamPbNtrb27H8ju/ht7/tRltbzAFxOKbHO4oH9tsHvwi542iCEALZbB6dnfvhppuXVSUUL+EQEa644jJs2bINoaAJduMhDwHEhjGRRiEG9nu2RqDtoNtsDMNAT08W5yw4CxdccBG2b9/uozZOQnn/vXdx3bVXIRwOQDcr4PIgRsOjAKC3HGw0Tcy/Fq92G8gSM5ki/uPGW3DwwVORyWRgGCaEENBaY5dddsVjjz2Kn/70IezSEYVtq2GDONQrFc1NKo0ei7JtC5ZVv6kB4hcRwbJsJBKtWH7nChARUqk+5HJZZLMZpFJJCCFx5RWX4ZVX/4hYLDwkkj2STNzExProumRbWwd22WXXsljgKCwC0WhsQMLtCApZzDi6CzfedBsefujHiMXi0O5klOGWeit/8XMceujnqieVBgKCm+VwTQK8ePFisXTpUr1tW3Y8A+8JaUSUspmo4dLKIcU/b41LsViqdllmRKLRysLLQbTCcDjsVCBVGpmjYpdKzs12JKipbrJ/DsSbB1GEks3aDIREKll886DJoWn93TdiDBoiuF7SH25jZkQiUcRi8bojKaWaXmSey+UghKjriW3bFSW7QVd5ADB5eAbYP4A5ACH45nhpaEDVXrQfqEbxjoYQKzwq453H+y0RNa3QNK1X0ghi4HAWkXpzFmhgXUKIIQE1uHojG0r/fpSUroiyO0Ky6R/AXB4qGHRcAoxm45/WumxhzoJRRjQag5SEbDYPIUYPwFw+D0NKmKbRcLCZGa2tUQBAOp0f1cEblMbkASjVvJqilEI8HsILLzyHzkkT8PkjDsbh0w7EtEM7cdyc6XjttVcQjYZg23Z5SZr32igG1n7mrUi1bRtSSuRzOZwwdyZW3HMXYvEALKtUBZxSCoZh4PFVj+OJJ56ElDQsajMiGuOfXK5apNNPXCoWbey773745uVXwww4FyWlwM8efhAXfXUBul/+PcaNGwvDcAbHNIFsVsOyLLS1RZHL2bAs250DjkIpIJfLo709Wl5iQQTk8wpKa3zyyUfo6dkOUwq0tLSgUCi6q2FNhMPOMt+bb16CltYEzjpzHpJpC7Ztj6olitEKC85KUYHenh489/yzOP6EL+I7i67D9d++Bjfdcjs++eQTbNy4EX/72/s456yzMXPGdJy74Hys/+RDvLtuLU45+WS8886fEQ6bkFLi6quuwOJF1yEcCmDFPffhhOOPw9wvzMGdy+8Cs11eiZVIJPDEE7/EeefNRyaTRjwewNq1b+O0007FW2+twT777IePP/oAJ5x4El5//XeIRptXsoclZy1ZsoQBQGe5LDxzE2dw1v8JfPrpFrz26stYt24tfvFfT+CeFffju0sXYeJee0MrhROPn4NNmzfi3PPOwYcf/AMnn3wSAMLqF5/Hww/9GNGwxN///j7u/v5yxFtaceutN+Ob37gEu+66O/acsCeuufpyXHXl5QiFglBKwQwE8M47a/Dfj69CsVhEwBTYsmUzfvPrp7Fly2aQENCaEQ6FKysW+qFr3NB0Bp4Z7teF5S5jMjqbypMQUVaqKSbDDEjDgJQCVqmEa264Ghs3bMDBUw/Bww8/ihdeeA4bN6zHNdfegM7OSThjvsS3vnkp3njj91j4r5fgsVWPoviDFXj+uWcRj8dx1IyZ+MppX8Ill34dK+75PgBg/B4TcOfyW3He+RciEolAKYVoJIpEIlG+bMMwIKVEMBhELpdDZ+eBeOqpJ5BMW8hli3UsoZHaBIDdhbKpajV0EAskImaA9u9AmhmbpDQay4ADGKVSGuP32AMLFlwAKSVuvPFWHDOzC+vWrUVLaysee2wlrrziSvzq6Sdw4klfQnt7B7785XnYvHkzXn7lNTz77G9w9MxjkUi0IZlMoqtrBvJFhUzOxpGfnw7btrFl8yYYhpN9vSQjDQOsNQzDqKJOtm0jk7VQLBQdNsFNuSxLAyDCBwDQ3d043DXc2b16tSQi1pr/bBiCwf6bTHhQHmgYBmzLxqJF38HkyVNw6SUL0duXxdSphyKTyeCBBx7CW2/9CQ/86GfYa699MHGvvXHkkYdh0qTJuPnGxVj7zp9x6ryvYOLEiYhEInj2md8gGJSIRQw8+8yvEQqFsefEvaGUhmFItLQmkE6nsWnjRggh8Prrv4MhDWfZm1udxKKme3/KkKunNwAAs4aURJxv24xnbQXSmsk/ec0DyF+lUgm2bSOdSSMeC2LFvT/Chg3rMX/+GTj7nPMxZUonjj3mCCxYsABHH3Uonn7qcSQSCbS2RPAvXz4F3d0vwgwEMGvWcWhvi+K66xfj0UcfxlHTZ2DmzGPxwwfuwxVXXot9990PGzduwPbt2zB37lzEYjF85fQvYdas2bjv3rthKxuWZWHChD3R3f0iuro8KhUYPIkwAAiZSZdskvIFF5GGP2pIzx98cAkvXboUF3/t2vW2thcGQ2ZEaw3h5n//Tc+1VMa2FUKhEI6bMxexeBsm7LknOjsPRCrVh0MPOxwLF14MISQ+/XQbvjD3BKy494cYP34PFIoKEyZMhGkGceaZ5+Coo2YgnSngmGOOxRFHdKGnZzvaEu349vWLceFFC5HPO8vYDj+iC0dN70LX9KNRsizsvttYXHvddzBu7DgcNeNozJkzF6ZhgITEjBkzMX78OFiWqhIb/DW/c3sDq3AkRLms9VrnfuE7/I97aTpTr1692pg9e7b97vup23YfG78qk8rYhiENJ/42fhaCd7tBLCaRTitYVgnMjHg8gmAA6O1zbj1oaTHLETmddiwFAEzTRDxuoGQBGbdycH4fRsBd9WvZQCrlfJZIhFAsAtlsHrFoGKGQc0GFIhAIAJmMDYAQi0sIAJmsRrHozqtQJcd694h4aoxlsQpHw7K3r3jqlH1CT3tYDCkLd3d3a2am/3k/vWzbtuyFsWigTStbE5Hoj4c6i4RK2LrV0fk8pTmVyro8UcK2ga1bi2VwvO8Bzm1bW7cWQETl2pWIkExm4V/j6n22bVvGXSsokM3mkE5rd2Adpbr8va3KfZ6MrCfRXFtRaRWLR2RPT+GVyXuHfulanz0srug9N2HNur5zdh/X+kgxn7eEYFMI5+Zm8Rl6VhsN4wf+Kstdma8BCaWplC/qaZP2Cv1lIPdtYk6E1OrVq42DOhOPbt7Sd3dLa9hkDYv1aN7EOjqNR4C2ew+gJhCHwgGRTRcXuuDJwR5K1syDdwjO40/UX/+R/ske42JfTaXyCsxkGELQZ+ihdzTEL5ZvqLG1koYhA4EAtm3PfWO/vaJ3r17NxuzZ/bvukM7pf2LbB5/kv9vaErxBCkKhkLeJWAjx2XBmGpL7MmvtzILGW8Iyn7fTqZT1b3vvGXm0WfCGdE4/iB9vyJ8QicjbYjFzqrKBfL4AZraHG47+WeA5VZZzp5wQUkYiASgFFIvWM8mcvmLvcaF1Q30M3nCeH+gkljVrAruP3/9cKcVFWqmu1tagADn31zJ/Ni3Qe6qb0kAmU8yCxIua6b6OVvMZ/7Xt0OQFAKtWsTzzzMqJ0unigUxyulLqEK0xQbOK/l8AOLBEIJgEJYXAByC8qWXgd+0R+rjWu3Z49q9NLnAeA/pZSshDuQbhAqd2ZOhotiPCzwo+o5gRAOruBmbNgh7uc1N3tp1tZ9vZdjan/S9NFfKr6D/2hgAAAABJRU5ErkJggg==",
  nubank: "data:image/png;base64,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",
  will: "data:image/png;base64,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",
  btg: "data:image/png;base64,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",
  mercadopago: "data:image/png;base64,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",
  xp: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAYAAACOEfKtAAAJ0UlEQVR42u2ca0gU3xvHv2dmL1pLPzUSKqObtEEFbdk9zO0CEqUZEhVahARBL4ouEHRBQ6Gg3lX4IkNSXxZloVIvSoNIK8pu7zSkTCnK1lrby8x5/i/qDOu6O87a7taf5oEDMs6eOfOZ5zzznO+cc0C/TFEUIiLyer1UX19PxcXFNGvWLEpNTSUA/1xhjFFqairNnj2biouLqa6ujr5//z6MFRERQg80NzeTy+X6J4EZKS6Xi5qbm4mISFXVnwDFH1evXtVOlCSJJEkixtg/D40xpvEQx+rq6jRPBBFRe3s7Wa1WYoyRLMumt0UpsiwTY4xsNht1dHT89EBFUWjdunXaCSYofW+0WCwEgDZs2ECqqhJaW1vJYrGY3TVGkLIsU2trK8mZmZnlDx48gCRJICKYNrpJkgTOOTIzMyHLslze09MDxpgJ0KAJVpIkQQ4Gg+Xfvn0zqYzBFEUBs9vt5Pf7TRpjMLvdDvYrMJo21nhoIjABmgBNgCZA00yAJkAToAnQNBOgCdAEaAI0zQRoAjQBmgBNMwGaAE2AJkDTTIAmQBOgCdA0E6AJ0ARoAjQtklniWRljzNB5Y53IabT+37VY2vdHpreNZTZssmfQSpKkXVOUhAKUJAkpKSmGzh0aGtK8KRYoDocDnPOEglNVFZEmnMqyDFVV49+FxVNyOBy4ffs2Jk+ejEAgAFmWR5zLOYfVakVjYyMOHz4Mi8UCznlUKIwxMMbAOcfFixeRn5+PQCAASUpc6Pb7/RgYGEB/fz+ePXuGtrY2tLe3a/DEBPNhXf53i1jFU1RUREatqqqKAJDVao1ar1iTUVVVRX/SOjo6aPfu3dpSkNBVS78FkDGmFbFIp7i4mAKBAAWDQVIUhVRVHVGCwSARER08eHAYqEjwysrKiIgoGAxGrEtVVW2tX7T/x1oURdFKqLW0tNCMGTPCIcYHIGNM86Y9e/ZoN8Q5H/FEOeda43bt2jUCongYa9euJb/fH7We0EV/Hz9+TJgHhj70t2/fktPpDG1n/ACGLoU6cOCAtiAvGkRVVSkQCNDGjRu1BoknO2fOHOrv7x8GKdzETV24cIFOnDgxYilqvC0QCBAR0cuXLyktLS0xAEO96fjx47oQBRiPx0NLly7VukZ6ejp1dnbqAhHwWlpahl1LHE+UifrPnTsX/y4sAIbGxLNnz+remID4/v17mj17NgGglpYW3d+I4/fu3aMJEyYQAKqoqBj1OrHEvmheL3rO4OCg6MqJXZAHgC5duqR7c8LLOjo6qKamRtfzQs9NT0/XHtypU6fi7oHRIIrjZ86cIUsih0Occ0iShP379yMtLQ07duyAoiiwWCwjklQiwpIlS7BkyRJwziPmkaqqQpZlvHnzBlu3bsXAwABSUlLg8/l028EYQ0VFBTo7O2G1WnXzTofDgZycHBQUFCArK0u7h0i5b1lZGRLmgeHd3Gq10q1btwx1Mz3P6+npoVmzZmkvHRFvo3mgiL0ixhotkyZNotraWl1PpF/DqISvrxVvVofDQffv34+5q4kb+PTpEy1cuHBYqmMU4Pr160mWZbLZbCTLsm4JTanu3LkTtb2cc0qKnCW6wffv31FUVITHjx9rwzgjoUCSJHz79g2FhYV4/vx51HHpaPWoqmqohIaZqqqqiN1YdOWk6YGiEQMDAygqKsKLFy+0ce5ospLH48H27dvx8OFDWCyWmOGNVVRgjOHly5f4+PFj1AXpSRVUhZjQ29uL0tJSBAIBXZmKcw7GGM6ePYumpibY7XYoipK09hIRfD4fxHrqPw6QMQZFUZCamorTp0/DZrNpb8loEhnnHHv37sWiRYvg9/sjvp0TaTabDePHj//zkr6QphhjqK2tRWFhoRbfRlOgZ86ciRs3biA7O1tLZZIhqEqShOzsbGRmZkZ90FKy4Alvqq6uxrZt26AoiiFdT5IkqKqKadOmobGxEVOmTIGqqjFrggLIaEWW5WE65cGDB7W4Gw5QdOmkbBECgM6fPz9sUD6WPPDJkyeUkZGhpUdG05hVq1bFvMmOGB7q5YGWRHufLMtQFAUnTpzAoUOHoChKxC4Y2p0jdRdRz+LFi3Ht2jVs2rQJXq93xKgmms2fPx9er1d3JCJJEsaPHw+Xy4WdO3ciJycnagpDRPjx40diPTBc2goGg7qqTHd3N3V3dxuSsG7evEk2m21UDwz1xGiaYqinhnu9Xnurq6sTNxIRN1ZSUmKoMV++fKG5c+fSggULaHBwUFM99CA2NDRo+1mVl5fHRUwQYu9oaozP56PFixcnBqCAt2XLFk2K1xNVh4aGaMOGDdrvCwsLtXgYzWsEqCtXrhjywFAv1CtG9cDa2trf1wP14OXl5ZHX643qSaGyfklJifZb8ft9+/bpem7ozRw7doyOHDmScEFVtLevr4+ysrKE/hnf7eEAUE5ODn3+/DlqLOOcazd69OjREV/nwr/G6UER9Xd1dSXlm4jH46E1a9aEiiTxVVycTie9e/dOS1eEB4YWkcacP39eAxa6e1xo6iMkpUAgoKsmh6vO4V4bqR2jqdMi/Ah7/fo1rVixInyrwPjAY4zR3Llzqaenx9BTbWho0OBF2i1T7Bxpt9vp7t27f/S7cFdXF508eZLS0tJG7LMYl6kdYohWV1cHt9ut5Wfh+RznHBaLBY8ePUJpaSmCweAwMSF8sC5GLxMnTkR9fT2cTufPDb90JhnJsoyvX78iIyMD06dP19rQ398Pj8czat6oqiqGhobw4cMHvHr1Cm1tbXjw4AEGBwcjzkzQNh+Lx+Sd//77T1ccEMny169fDU8YCj1Hb26MGC56vV7k5eXhzJkzWiIsyzIKCgpw584d2Gy2qHIYY0ybGxPeLjGcCz1ut9uBqVOnal0GSdwBMpbrxXJuWVkZ+f3+Ecmz2+2OOSwJhTpSeAFAU6dOJcvMmTPR29urDdr/xvmB4vxo9QuFOjc3F5cvXx4m4IrfyrIMxphhNVtP6BW9YsaMGZCWL18eVwHSSIl3/eJmT58+DQARlR6jbTPSRvEgV65cCWnz5s2Gv0/8jSaCutPpxLJly0BECdcLRVzdvHkzpNWrV8PtdoOIDCsbf5MJb5g3bx7sdrv2GSBRJrILt9uNVatWQZIkCZWVldrbKdmSebwAZmVljSm+xirNqaoKq9WKysrKnyIs5xxLly5FTU2N9ulPKLPJmtQdD5swYUJC1XTxkiUi1NTUYNmyZYLVzxhSUlKC5uZmuFwucM5H5Dz/D7EwkVNUOOdwuVxoampCaWmpFgct4uKKoiA/Px+5ubm4fv06Ghsb8fTpU/T19cHn8/1ze0wzxpCSkoIpU6bA5XJhy5YtKCoqwrhx44ap1P8D0XL4y1uz3HcAAAAASUVORK5CYII="
};
var BANK_PRESETS = {
  santander:{label:"Santander", short:"S", emoji:"🔴", bg:"#E11931", fg:"#ffffff", ring:"#FFB4BE", mark:"S"},
  itau:{label:"Itaú", short:"itaú", emoji:"🟧", bg:"#FF7A00", fg:"#ffffff", ring:"#1D2A7A", mark:"i"},
  bradesco:{label:"Bradesco", short:"B", emoji:"🔺", bg:"#CC092F", fg:"#ffffff", ring:"#FFD2DC", mark:"B"},
  nubank:{label:"Nubank", short:"nu", emoji:"🟣", bg:"#8A05BE", fg:"#ffffff", ring:"#E0B3FF", mark:"nu"},
  inter:{label:"Inter", short:"Inter", emoji:"🟠", bg:"#FF7A00", fg:"#ffffff", ring:"#FFD2B3", mark:"Inter"},
  bb:{label:"Banco do Brasil", short:"BB", emoji:"🟡", bg:"#FFDD00", fg:"#1034A6", ring:"#A6C8FF", mark:"BB"},
  caixa:{label:"Caixa", short:"CAIXA", emoji:"🔵", bg:"#005CA9", fg:"#F39200", ring:"#A6D8FF", mark:"CX"},
  brb:{label:"BRB", short:"BRB", emoji:"🔷", bg:"#0057B8", fg:"#ffffff", ring:"#B3D7FF", mark:"BRB"},
  revolut:{label:"Revolut", short:"R", emoji:"⚡", bg:"#0075EB", fg:"#ffffff", ring:"#00D4FF", mark:"R"},
  will:{label:"Will Bank", short:"W", emoji:"🟡", bg:"#FFD200", fg:"#1A1A1A", ring:"#FFE566", mark:"W"},
  btg:{label:"BTG Pactual", short:"btg", emoji:"🔵", bg:"#0055A4", fg:"#ffffff", ring:"#4DA6FF", mark:"btg"},
  mercadopago:{label:"Mercado Pago", short:"MP", emoji:"🤝", bg:"#00B1EA", fg:"#ffffff", ring:"#4DD4FF", mark:"MP"},
  xp:{label:"XP", short:"XP", emoji:"⬛", bg:"#1A1A1A", fg:"#FFD000", ring:"#333333", mark:"XP"},
  custom:{label:"Personalizado", short:"CARD", emoji:"💳", bg:"#1F2937", fg:"#ffffff", ring:"#94A3B8", mark:"CARD"}
};
var BANK_OPTIONS = Object.keys(BANK_PRESETS).map(function(k){ return {v:k, l:BANK_PRESETS[k].label}; });
function inferBankKey(name) {
  var t = String(name||"").toLowerCase();
  if (t.indexOf("santander") >= 0 || t.indexOf("aadvantage") >= 0) return "santander";
  if (t.indexOf("itau") >= 0 || t.indexOf("itaú") >= 0) return "itau";
  if (t.indexOf("bradesco") >= 0) return "bradesco";
  if (t.indexOf("nubank") >= 0 || t === "nu") return "nubank";
  if (t.indexOf("banco inter") >= 0 || t === "inter") return "inter";
  if (t.indexOf("banco do brasil") >= 0 || t.indexOf(" bb") >= 0 || t==="bb") return "bb";
  if (t.indexOf("caixa") >= 0) return "caixa";
  if (t.indexOf("brb") >= 0) return "brb";
  if (t.indexOf("revolut") >= 0) return "revolut";
  if (t.indexOf("will") >= 0) return "will";
  if (t.indexOf("btg") >= 0) return "btg";
  if (t.indexOf("mercado") >= 0 || t.indexOf("mp") >= 0) return "mercadopago";
  if (t.indexOf("xp") >= 0) return "xp";
  return "custom";
}
function getBankPreset(card) {
  var key = (card && card.bankKey) || inferBankKey(card && card.nome);
  return BANK_PRESETS[key] || BANK_PRESETS.custom;
}
function toDataUri(svg) { return "data:image/svg+xml;utf8," + encodeURIComponent(svg); }
function getBankLogoSrc(card) {
  if (card && card.logoUrl) return card.logoUrl;
  var key = (card && card.bankKey) || inferBankKey(card && card.nome);
  if (BANK_LOGOS[key]) return BANK_LOGOS[key];
  var b = getBankPreset(card);
  var key = (card && card.bankKey) || inferBankKey(card && card.nome);
  var svg = "";
  if (key === "itau") {
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112"><rect width="112" height="112" rx="28" fill="#FF7A00"/><rect x="4" y="4" width="104" height="104" rx="24" fill="#003F8A"/><text x="56" y="68" text-anchor="middle" font-family="Arial Black, sans-serif" font-size="40" font-weight="900" fill="#FF7A00">itau</text></svg>';
  } else if (key === "santander") {
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112"><rect width="112" height="112" rx="28" fill="#E11931"/><circle cx="56" cy="52" r="30" fill="none" stroke="#fff" stroke-width="3"/><path d="M56 26 L62 48 L56 42 L50 48 Z" fill="#fff"/><path d="M36 62 L52 50 L46 56 L52 62 Z" fill="#fff"/><path d="M76 62 L60 50 L66 56 L60 62 Z" fill="#fff"/><text x="56" y="100" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="#fff">SANTANDER</text></svg>';
  } else if (key === "bradesco") {
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112"><rect width="112" height="112" rx="28" fill="#CC092F"/><rect x="4" y="4" width="104" height="104" rx="24" fill="#1A0008"/><path d="M30 56 Q56 20 82 56 Q56 92 30 56Z" fill="none" stroke="#CC092F" stroke-width="4"/><text x="56" y="62" text-anchor="middle" font-family="Arial Black, sans-serif" font-size="22" font-weight="900" fill="#CC092F">BRA</text></svg>';
  } else if (key === "brb") {
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112"><rect width="112" height="112" rx="28" fill="#0057B8"/><rect x="6" y="6" width="100" height="100" rx="22" fill="#001A4A"/><text x="56" y="66" text-anchor="middle" font-family="Arial Black, sans-serif" font-size="32" font-weight="900" fill="#4DA6FF">BRB</text></svg>';
  } else if (key === "revolut") {
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112"><rect width="112" height="112" rx="28" fill="#0075EB"/><rect x="4" y="4" width="104" height="104" rx="24" fill="#0A0A14"/><circle cx="56" cy="50" r="22" fill="none" stroke="#0075EB" stroke-width="3"/><path d="M56 28 L56 72" stroke="#0075EB" stroke-width="2"/><path d="M44 58 L56 72 L68 58" fill="none" stroke="#00D4FF" stroke-width="2.5"/><text x="56" y="98" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#0075EB" letter-spacing="3">REVOLUT</text></svg>';
  } else if (key === "nubank") {
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112"><rect width="112" height="112" rx="28" fill="#8A05BE"/><rect x="6" y="6" width="100" height="100" rx="22" fill="#1A0030"/><text x="56" y="66" text-anchor="middle" font-family="Arial Black, sans-serif" font-size="32" font-weight="900" fill="#8A05BE">Nu</text></svg>';
  } else {
    var txt = b.short || b.label || "CARD";
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="'+b.bg+'"/><stop offset="100%" stop-color="'+(card&&card.cor?card.cor:b.ring)+'"/></linearGradient></defs><rect x="4" y="4" width="104" height="104" rx="28" fill="url(#g)"/><rect x="10" y="10" width="92" height="92" rx="24" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.18)"/><text x="56" y="61" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="'+b.fg+'">'+txt+'</text></svg>';
  }
  return toDataUri(svg);
}
function getBankTheme(bankKey) {
  if (bankKey === "santander") return {accent:"#E11931", accent2:"#6B0F1B", glow:"rgba(225,25,49,0.32)", shell:"rgba(255,255,255,0.08)"};
  if (bankKey === "itau") return {accent:"#FF7A00", accent2:"#1D2A7A", glow:"rgba(255,122,0,0.30)", shell:"rgba(255,255,255,0.08)"};
  if (bankKey === "bradesco") return {accent:"#CC092F", accent2:"#4C0A17", glow:"rgba(204,9,47,0.28)", shell:"rgba(255,255,255,0.08)"};
  if (bankKey === "brb") return {accent:"#0057B8", accent2:"#143056", glow:"rgba(0,87,184,0.28)", shell:"rgba(255,255,255,0.08)"};
  if (bankKey === "revolut") return {accent:"#0075EB", accent2:"#001A3A", glow:"rgba(0,117,235,0.28)", shell:"rgba(255,255,255,0.08)"};
  if (bankKey === "will") return {accent:"#FFD200", accent2:"#8B7300", glow:"rgba(255,210,0,0.28)", shell:"rgba(255,255,255,0.08)"};
  if (bankKey === "btg") return {accent:"#0055A4", accent2:"#002244", glow:"rgba(0,85,164,0.28)", shell:"rgba(255,255,255,0.08)"};
  if (bankKey === "mercadopago") return {accent:"#00B1EA", accent2:"#003A6B", glow:"rgba(0,177,234,0.28)", shell:"rgba(255,255,255,0.08)"};
  if (bankKey === "xp") return {accent:"#FFD000", accent2:"#1A1A1A", glow:"rgba(255,208,0,0.25)", shell:"rgba(255,255,255,0.08)"};
  return {accent:"#3B82F6", accent2:"#111827", glow:"rgba(59,130,246,0.22)", shell:"rgba(255,255,255,0.08)"};
}
function getCardStatusColor(status) {
  if (status === "foco_mes") return T.gold;
  if (status === "concentrar_gastos") return T.cyan;
  if (status === "prioritario") return T.green;
  if (status === "manter_estável") return T.blue;
  if (status === "evitar_uso_alto") return T.red;
  if (status === "usar_moderadamente") return T.amber;
  return T.steel;
}
function getCardStatusLabel(status) {
  if (status === "foco_mes") return "Foco do mês";
  if (status === "concentrar_gastos") return "Concentrar gastos";
  if (status === "prioritario") return "Cartao prioritario";
  if (status === "manter_estável") return "Manter estável";
  if (status === "evitar_uso_alto") return "Evitar uso alto";
  if (status === "usar_moderadamente") return "Usar moderadamente";
  return "Estrategia livre";
}
function getCardBrandStyle(card) {
  var bankKey = (card && card.bankKey) || inferBankKey(card && card.nome);
  var b = getBankPreset(card);
  var th = getBankTheme(bankKey);
  var c1 = (card && card.cor) || th.accent || b.bg;
  var c2 = (card && card.cor2) || th.accent2 || b.ring;
  var visual = (card && card.visual) || "black";
  var background = "linear-gradient(145deg, rgba(6,10,16,0.98), rgba(18,24,34,0.98) 46%, rgba(38,42,48,0.98))";
  if (visual === "metal") background = "linear-gradient(145deg, rgba(46,54,65,0.98), rgba(18,24,34,0.98) 38%, rgba(86,96,112,0.94))";
  if (visual === "executive") background = "linear-gradient(145deg, rgba(14,18,28,0.98), rgba(15,23,42,0.98) 38%, rgba(44,51,66,0.98))";
  if (visual === "classic") background = "linear-gradient(145deg, rgba(17,24,39,0.98), rgba(31,41,55,0.98) 42%, rgba(17,24,39,0.98))";
  if (visual === "fintech") background = "linear-gradient(145deg, rgba(7,11,20,0.98), rgba(8,23,42,0.98) 42%, rgba(16,38,62,0.94))";
  return {
    background: background,
    accent: c1,
    accent2: c2,
    glow: th.glow,
    line: "linear-gradient(90deg, " + c1 + ", " + c2 + ")",
    ring: b.ring || c2,
    statusColor: getCardStatusColor(card && card.statusEstr),
    boxShadow: "0 18px 44px rgba(0,0,0,0.34), 0 0 28px " + c1 + "22"
  };
}
function BankBadge(props) {
  var tone = props.color || T.blue;
  return <span style={{padding:"4px 10px",borderRadius:999,border:"1px solid "+tone+"28",background:"linear-gradient(180deg, "+tone+"22, "+tone+"10)",color:tone,fontSize:11,fontWeight:800,letterSpacing:0.5,textTransform:"uppercase",boxShadow:"0 2px 8px "+tone+"18, inset 0 1px 0 rgba(255,255,255,0.06)"}}>{props.children}</span>;
}
function BankMark(props) {
  var card = props.card || {};
  var sz = props.size || 40;
  var src = getBankLogoSrc(card);
  return <img src={src} alt="" style={{width:sz,height:sz,borderRadius:sz*0.28,objectFit:"cover",boxShadow:"0 4px 14px rgba(0,0,0,0.30), 0 0 0 1px rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.10)"}} />;
}
function NetChip(props) {
  return <span style={{padding:"3px 9px",borderRadius:999,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.10)",fontSize:11,fontWeight:800,color:"rgba(255,255,255,0.75)",letterSpacing:0.4,textTransform:"uppercase"}}>{props.label || "CARD"}</span>;
}

function useAnimNum(target, duration) {
  var d = duration || 900;
  var _v = useState(0);
  var v = _v[0];
  var setV = _v[1];
  var prevTarget = useRef(0);
  useEffect(function() {
    var start = Date.now();
    var from = prevTarget.current;
    var to = Number(target) || 0;
    prevTarget.current = to;
    var raf;
    function tick() {
      var t = Math.min(1, (Date.now() - start) / d);
      var eased = 1 - Math.pow(1 - t, 3);
      setV(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    tick();
    return function(){ if(raf) cancelAnimationFrame(raf); };
  }, [target]);
  return v;
}

function AnimNum(props) {
  var target = Number(props.value) || 0;
  var animated = useAnimNum(target, props.duration || 900);
  var formatter = props.format || function(n) { return n.toLocaleString("pt-BR", {minimumFractionDigits:2, maximumFractionDigits:2}); };
  return <span style={props.style}>{formatter(animated)}</span>;
}

function FlipDigit(props) {
  var ch = String(props.ch);
  var prevRef = useRef(ch);
  var _flip = useState(false); var flip = _flip[0]; var setFlip = _flip[1];
  var _from = useState(ch); var from = _from[0]; var setFrom = _from[1];
  useEffect(function(){
    if (prevRef.current !== ch) {
      setFrom(prevRef.current);
      setFlip(true);
      var t = setTimeout(function(){ setFlip(false); prevRef.current = ch; }, 480);
      return function(){ clearTimeout(t); };
    }
  }, [ch]);
  var isDigit = /^[0-9]$/.test(ch);
  if (!isDigit) return <span style={Object.assign({display:"inline-block",verticalAlign:"baseline"}, props.charStyle||{})}>{ch}</span>;
  var size = props.size || 36;
  var w = Math.round(size * 0.62);
  var color = props.color || "#EAF2FF";
  return <span style={{display:"inline-block",height:size,width:w,position:"relative",overflow:"hidden",verticalAlign:"baseline",lineHeight:size+"px",perspective:"260px"}}>
    <span style={{display:"block",height:size,position:"relative",transformStyle:"preserve-3d",transition:"transform 0.45s cubic-bezier(0.4,0,0.2,1)",transform:flip?"rotateX(-90deg)":"rotateX(0deg)",transformOrigin:"center "+(size/2)+"px"}}>
      <span style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",backfaceVisibility:"hidden",color:color,fontFamily:FF.mono,fontVariantNumeric:"tabular-nums",fontSize:size*0.78,letterSpacing:"-0.02em"}}>{ch}</span>
      <span style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",backfaceVisibility:"hidden",transform:"rotateX(90deg)",color:color,fontFamily:FF.mono,fontVariantNumeric:"tabular-nums",fontSize:size*0.78,letterSpacing:"-0.02em"}}>{flip ? from : ch}</span>
    </span>
    <span style={{position:"absolute",left:0,right:0,top:"50%",height:1,background:"rgba(0,0,0,0.4)",pointerEvents:"none",zIndex:2}} />
  </span>;
}

function FlipNumber(props) {
  var target = Number(props.value) || 0;
  var animated = useAnimNum(target, props.duration || 1100);
  var size = props.size || 36;
  var color = props.color || "#EAF2FF";
  var prefix = props.prefix || "";
  var formatter = props.format || function(n){ return n.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2}); };
  var s = (animated < 0 ? "-" : "") + formatter(Math.abs(animated));
  var chars = (prefix + s).split("");
  return <span style={Object.assign({display:"inline-flex",alignItems:"baseline",gap:0,verticalAlign:"baseline",lineHeight:1.1},props.style||{})}>
    {chars.map(function(c,i){
      var isDigit = /^[0-9]$/.test(c);
      if (!isDigit) return <span key={i} style={{display:"inline-block",fontFamily:FF.mono,fontSize:size*0.78,color:color,padding:"0 1px",letterSpacing:"-0.02em"}}>{c}</span>;
      return <FlipDigit key={i} ch={c} size={size} color={color} />;
    })}
  </span>;
}

function CelebrationBurst(props) {
  if (!props.show) return null;
  var col = props.color || "#A8FF3E";
  var col2 = props.color2 || "#00F5D4";
  var rays = [];
  for (var i = 0; i < 12; i++) {
    var ang = (i * 30) * (Math.PI/180);
    var x2 = 50 + Math.cos(ang) * 42;
    var y2 = 50 + Math.sin(ang) * 42;
    rays.push(<line key={"r"+i} x1="50" y1="50" x2={x2} y2={y2} stroke={i % 2 === 0 ? col : col2} strokeWidth="1.4" strokeLinecap="round" style={{transformOrigin:"50px 50px",animation:"burstRay 1.4s ease-out "+(i*0.02)+"s forwards",opacity:0}} />);
  }
  var sparkles = [];
  for (var j = 0; j < 16; j++) {
    var ang2 = (j * 22.5) * (Math.PI/180);
    var dist = 18 + (j % 3) * 9;
    var sx = 50 + Math.cos(ang2) * dist;
    var sy = 50 + Math.sin(ang2) * dist;
    var c = [col, col2, "#FF00E5", "#FFB800"][j % 4];
    sparkles.push(<circle key={"s"+j} cx={sx} cy={sy} r="1.2" fill={c} style={{animation:"sparkleOut 1.6s cubic-bezier(0.2,0.8,0.2,1) "+(0.1+(j*0.04))+"s forwards",opacity:0,transformOrigin:sx+"px "+sy+"px"}} />);
  }
  return <div aria-hidden="true" style={{position:"absolute",inset:0,pointerEvents:"none",zIndex:5,overflow:"visible"}}>
    <svg viewBox="0 0 100 100" style={{position:"absolute",top:"50%",left:"50%",width:300,height:300,transform:"translate(-50%,-50%)",overflow:"visible"}}>
      <circle cx="50" cy="50" r="6" fill="none" stroke={col} strokeWidth="2" style={{transformOrigin:"50px 50px",animation:"ringBurst 1.4s cubic-bezier(0.2,0.8,0.2,1) forwards",opacity:0}} />
      <circle cx="50" cy="50" r="6" fill="none" stroke={col2} strokeWidth="1.4" style={{transformOrigin:"50px 50px",animation:"ringBurst 1.6s cubic-bezier(0.2,0.8,0.2,1) 0.15s forwards",opacity:0}} />
      <circle cx="50" cy="50" r="6" fill="none" stroke="#FF00E5" strokeWidth="1" style={{transformOrigin:"50px 50px",animation:"ringBurst 1.8s cubic-bezier(0.2,0.8,0.2,1) 0.3s forwards",opacity:0}} />
      {rays}
      {sparkles}
    </svg>
  </div>;
}

function LoadingIntro(props) {
  var _stage = useState(0); var stage = _stage[0]; var setStage = _stage[1];
  useEffect(function(){
    var t1 = setTimeout(function(){ setStage(1); }, 80);
    var t2 = setTimeout(function(){ setStage(2); }, 380);
    var t3 = setTimeout(function(){ setStage(3); }, 850);
    var t4 = setTimeout(function(){ setStage(4); }, 1200);
    var t5 = setTimeout(function(){ if (props.onComplete) props.onComplete(); }, 1550);
    return function(){ [t1,t2,t3,t4,t5].forEach(clearTimeout); };
  }, []);
  var bootLines = [
    "> COJUR_VAULT v16.0",
    "> Initializing core modules...",
    "> Loading user data...",
    "> Mounting glass panels...",
    "> System online · ready"
  ];
  return <div aria-hidden="true" style={{position:"fixed",inset:0,zIndex:9999,background:"radial-gradient(ellipse at center, #0A0E1C 0%, #04050C 100%)",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",opacity:stage>=4?0:1,transition:"opacity 0.4s cubic-bezier(0.2,0.8,0.2,1)",pointerEvents:stage>=4?"none":"auto"}}>
    <div aria-hidden="true" style={{position:"absolute",inset:0,backgroundImage:"linear-gradient(rgba(0,245,212,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(0,245,212,0.06) 1px, transparent 1px)",backgroundSize:"32px 32px",opacity:stage>=1?0.6:0,transition:"opacity 0.6s ease",animation:"breathe 4s ease-in-out infinite"}} />
    {(function(){
      var nodes = [];
      for (var i = 0; i < 18; i++) {
        var angle = (i * 20) * (Math.PI/180);
        var dist = stage>=2 ? 60 : 360;
        var x = Math.cos(angle) * dist;
        var y = Math.sin(angle) * dist;
        var col = ["#00F5D4","#7B4CFF","#FF00E5","#A8FF3E"][i % 4];
        nodes.push(<span key={"bp"+i} style={{position:"absolute",left:"50%",top:"50%",width:4,height:4,borderRadius:"50%",background:col,boxShadow:"0 0 10px "+col+",0 0 18px "+col+"60",transform:"translate(calc(-50% + "+x+"px), calc(-50% + "+y+"px))",transition:"transform 0.9s cubic-bezier(0.2,0.8,0.2,1) "+(i*0.02)+"s, opacity 0.3s",opacity:stage>=3?0:0.85}} />);
      }
      return nodes;
    })()}
    <div style={{position:"relative",zIndex:1,textAlign:"center",transform:stage>=3?"scale(1.05)":"scale(1)",transition:"transform 0.5s cubic-bezier(0.2,0.8,0.2,1)"}}>
      <div style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:88,height:88,borderRadius:22,background:"radial-gradient(circle at 30% 30%, rgba(255,255,255,0.18), transparent 60%), rgba(10,14,28,0.6)",border:"1px solid rgba(0,245,212,0.4)",boxShadow:"0 0 60px -10px #00F5D4, inset 0 1px 0 rgba(255,255,255,0.1)",position:"relative",overflow:"hidden",backdropFilter:"blur(28px) saturate(1.8)",WebkitBackdropFilter:"blur(28px) saturate(1.8)",animation:"breathe 3s ease-in-out infinite",transform:stage>=1?"scale(1) rotate(0deg)":"scale(0.4) rotate(-90deg)",opacity:stage>=1?1:0,transition:"all 0.6s cubic-bezier(0.34,1.56,0.64,1)"}}>
        <span style={{position:"absolute",inset:-2,borderRadius:24,border:"1px solid rgba(0,245,212,0.3)",animation:"orbitRing 6s linear infinite"}} />
        <span style={{position:"absolute",inset:-6,borderRadius:28,border:"1px dashed rgba(123,76,255,0.25)",animation:"orbitRing 12s linear infinite reverse"}} />
        <Wallet size={36} color="#00F5D4" style={{filter:"drop-shadow(0 0 12px #00F5D4)",position:"relative",zIndex:1}} />
      </div>
      <div style={{marginTop:24,fontFamily:"'Space Grotesk',sans-serif",fontSize:22,fontWeight:600,letterSpacing:"0.4em",textTransform:"uppercase",opacity:stage>=2?1:0,transform:stage>=2?"translateY(0)":"translateY(8px)",transition:"all 0.4s cubic-bezier(0.2,0.8,0.2,1) 0.1s"}}>
        <span style={{background:"linear-gradient(110deg,#00F5D4,#7B4CFF,#FF00E5,#00F5D4)",backgroundSize:"200% 100%",WebkitBackgroundClip:"text",backgroundClip:"text",color:"transparent",WebkitTextFillColor:"transparent",animation:"holoShimmer 4s linear infinite"}}>COJUR</span>
        <span style={{color:"rgba(234,242,255,0.6)",marginLeft:8}}>VAULT</span>
      </div>
      <div style={{marginTop:14,minHeight:18,fontFamily:"'Geist Mono',monospace",fontSize:11,color:"#00F5D4",letterSpacing:"0.18em",opacity:stage>=2?1:0,transition:"opacity 0.4s ease 0.2s"}}>
        {bootLines[Math.min(bootLines.length-1, Math.floor(stage * 1.2))]}<span className="blink-cursor" style={{display:"inline-block",width:1}} />
      </div>
      <div style={{marginTop:18,width:200,height:2,margin:"18px auto 0",background:"rgba(0,245,212,0.1)",borderRadius:2,overflow:"hidden",position:"relative",opacity:stage>=2?1:0,transition:"opacity 0.3s ease"}}>
        <div style={{position:"absolute",top:0,bottom:0,left:0,width:stage>=3?"100%":(stage>=2?"60%":"0%"),background:"linear-gradient(90deg, #00F5D4, #FF00E5)",transition:"width 0.7s cubic-bezier(0.2,0.8,0.2,1)",boxShadow:"0 0 8px #00F5D4"}} />
      </div>
    </div>
  </div>;
}

var ACHIEVEMENTS = [
  { id:"first_lanc", name:"Primeiro Passo", desc:"Adicionou o primeiro lançamento", icon:"Zap", rarity:"common", check:function(d){return (d.lancamentos||[]).length >= 1;} },
  { id:"first_meta", name:"Visão de Futuro", desc:"Criou a primeira meta financeira", icon:"Target", rarity:"common", check:function(d){return (d.metas||[]).length >= 1;} },
  { id:"first_invest", name:"Investidor Iniciante", desc:"Primeiro investimento registrado", icon:"PiggyBank", rarity:"common", check:function(d){return (d.investimentos||[]).length >= 1;} },
  { id:"meta_batida", name:"Mestre da Meta", desc:"Bateu a primeira meta financeira", icon:"CheckCircle", rarity:"rare", check:function(d){return (d.metas||[]).some(function(m){return (m.atual||0) >= (m.valor||0) && (m.valor||0) > 0;});} },
  { id:"trio_metas", name:"Trio Vencedor", desc:"Bateu três metas financeiras", icon:"Heart", rarity:"epic", check:function(d){return (d.metas||[]).filter(function(m){return (m.atual||0) >= (m.valor||0) && (m.valor||0) > 0;}).length >= 3;} },
  { id:"investido_5k", name:"Cinco Mil", desc:"Acumulou R$ 5.000 em investimentos", icon:"Landmark", rarity:"rare", check:function(d){var t=0;(d.investimentos||[]).forEach(function(i){t+=(i.valor||0);});return t >= 5000;} },
  { id:"investido_25k", name:"Vinte e Cinco K", desc:"Acumulou R$ 25.000 em investimentos", icon:"Landmark", rarity:"epic", check:function(d){var t=0;(d.investimentos||[]).forEach(function(i){t+=(i.valor||0);});return t >= 25000;} },
  { id:"investido_100k", name:"Patrimônio Sólido", desc:"Acumulou R$ 100.000 em investimentos", icon:"Shield", rarity:"legendary", check:function(d){var t=0;(d.investimentos||[]).forEach(function(i){t+=(i.valor||0);});return t >= 100000;} },
  { id:"sem_dividas", name:"Liberdade", desc:"Zerou todas as dívidas ativas", icon:"Shield", rarity:"epic", check:function(d){return (d.dividas||[]).length === 0 || (d.dividas||[]).every(function(x){return (x.pago||0) >= (x.total||0);});} },
  { id:"cinquenta_lanc", name:"Disciplinado", desc:"Registrou 50 lançamentos", icon:"Activity", rarity:"rare", check:function(d){return (d.lancamentos||[]).length >= 50;} },
  { id:"duzentos_lanc", name:"Cronista Financeiro", desc:"Registrou 200 lançamentos", icon:"BarChart3", rarity:"epic", check:function(d){return (d.lancamentos||[]).length >= 200;} },
  { id:"setup_completo", name:"Setup Completo", desc:"Configurou cartões, contas, metas e investimentos", icon:"CheckCircle", rarity:"rare", check:function(d){return (d.cartoes||[]).length >= 1 && (d.contas||[]).length >= 1 && (d.metas||[]).length >= 1 && (d.investimentos||[]).length >= 1;} }
];

function getRarityColor(r) {
  if (r === "legendary") return {c:"#FF00E5", c2:"#FFB800", glow:"rgba(255,0,229,0.55)", label:"LENDÁRIO"};
  if (r === "epic") return {c:"#7B4CFF", c2:"#00F5D4", glow:"rgba(123,76,255,0.45)", label:"ÉPICO"};
  if (r === "rare") return {c:"#00C2FF", c2:"#00F5D4", glow:"rgba(0,194,255,0.4)", label:"RARO"};
  return {c:"#A8FF3E", c2:"#00F5D4", glow:"rgba(168,255,62,0.35)", label:"COMUM"};
}

var ACH_ICON_MAP = { Zap:Zap, Target:Target, PiggyBank:PiggyBank, CheckCircle:CheckCircle, Heart:Heart, Landmark:Landmark, Shield:Shield, Activity:Activity, BarChart3:BarChart3 };

function AchievementBadge(props) {
  var ach = props.ach;
  var unlocked = props.unlocked;
  var rar = getRarityColor(ach.rarity);
  var Icon = ACH_ICON_MAP[ach.icon] || Zap;
  var size = props.size || 90;
  return <div className={"hover-tilt " + (unlocked ? "magnetic" : "")} style={{width:size,padding:"14px 12px",borderRadius:14,background:unlocked?"linear-gradient(160deg, rgba(10,14,28,0.55), rgba(14,18,36,0.30))":"linear-gradient(160deg, rgba(10,14,28,0.55), rgba(14,18,36,0.30))",border:"1px solid "+(unlocked?rar.c+"50":"rgba(255,255,255,0.06)"),boxShadow:unlocked?"0 0 28px -8px "+rar.glow+", inset 0 1px 0 rgba(255,255,255,0.06)":"inset 0 1px 0 rgba(255,255,255,0.03)",textAlign:"center",position:"relative",overflow:"hidden",backdropFilter:"blur(20px) saturate(1.5)",WebkitBackdropFilter:"blur(20px) saturate(1.5)",transition:"all 0.3s",cursor:"default",filter:unlocked?"none":"grayscale(0.85) brightness(0.55)",opacity:unlocked?1:0.6}}>
    {unlocked && <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:"linear-gradient(90deg, transparent, "+rar.c+", "+rar.c2+", transparent)",opacity:0.7}} />}
    <div style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:42,height:42,borderRadius:12,background:unlocked?"linear-gradient(135deg, "+rar.c+"22, "+rar.c2+"18)":"rgba(255,255,255,0.04)",border:"1px solid "+(unlocked?rar.c+"50":"rgba(255,255,255,0.08)"),marginBottom:8,position:"relative",boxShadow:unlocked?"inset 0 1px 0 rgba(255,255,255,0.1), 0 0 16px -4px "+rar.glow:"none"}}>
      <Icon size={20} color={unlocked ? rar.c : "rgba(255,255,255,0.25)"} style={unlocked?{filter:"drop-shadow(0 0 6px "+rar.c+")"}:{}} />
    </div>
    <div style={{fontFamily:FF.mono,fontSize:9,color:unlocked?rar.c:"rgba(255,255,255,0.3)",letterSpacing:"0.18em",textTransform:"uppercase",fontWeight:500,marginBottom:4}}>{rar.label}</div>
    <div style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:12,fontWeight:600,color:unlocked?T.text:"rgba(255,255,255,0.4)",letterSpacing:"-0.01em",lineHeight:1.2}}>{ach.name}</div>
    <div style={{fontSize:10,color:T.dim,marginTop:5,lineHeight:1.4,minHeight:28}}>{ach.desc}</div>
  </div>;
}

function AchievementUnlockModal(props) {
  if (!props.ach) return null;
  var rar = getRarityColor(props.ach.rarity);
  var Icon = ACH_ICON_MAP[props.ach.icon] || Zap;
  return <div onClick={props.onClose} style={{position:"fixed",inset:0,zIndex:1200,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(36px) saturate(1.6)",WebkitBackdropFilter:"blur(36px) saturate(1.6)",animation:"fadeIn 0.3s ease",padding:16}}>
    <div onClick={function(e){e.stopPropagation()}} className="modal-panel" style={{background:"linear-gradient(160deg, rgba(14,18,36,0.55), rgba(10,14,28,0.35))",border:"1px solid "+rar.c+"60",borderRadius:24,padding:"32px 28px",maxWidth:380,width:"100%",textAlign:"center",position:"relative",overflow:"hidden",boxShadow:"0 60px 120px -30px rgba(0,0,0,0.7), 0 0 80px -20px "+rar.glow+", inset 0 1px 0 rgba(255,255,255,0.08)",backdropFilter:"blur(48px) saturate(2)",WebkitBackdropFilter:"blur(48px) saturate(2)"}}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:"linear-gradient(90deg, transparent, "+rar.c+", "+rar.c2+", transparent)"}} />
      <div className="scan-overlay" />
      <CelebrationBurst show={true} color={rar.c} color2={rar.c2} />
      <div style={{fontFamily:FF.mono,fontSize:11,color:rar.c,letterSpacing:"0.32em",textTransform:"uppercase",marginBottom:20,position:"relative"}}>◇ achievement unlocked</div>
      <div style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:84,height:84,borderRadius:22,background:"linear-gradient(135deg, "+rar.c+"30, "+rar.c2+"20)",border:"1px solid "+rar.c+"60",marginBottom:18,position:"relative",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.12), 0 0 40px -8px "+rar.glow,animation:"breathe 3s ease-in-out infinite"}}>
        <span style={{position:"absolute",inset:-3,borderRadius:25,border:"1px solid "+rar.c+"40",animation:"orbitRing 8s linear infinite"}} />
        <span style={{position:"absolute",inset:-8,borderRadius:30,border:"1px dashed "+rar.c+"25",animation:"orbitRing 14s linear infinite reverse"}} />
        <Icon size={38} color={rar.c} style={{filter:"drop-shadow(0 0 12px "+rar.c+")",position:"relative",zIndex:1}} />
      </div>
      <div className="tag-mono" style={{display:"inline-flex",margin:"0 auto 12px",background:rar.c+"15",borderColor:rar.c+"40",color:rar.c}}>{rar.label}</div>
      <div className="serif-title" style={{fontSize:24,fontWeight:400,letterSpacing:"-0.015em",fontStyle:"italic",marginBottom:8,position:"relative"}}>{props.ach.name}</div>
      <div style={{fontSize:13,color:T.muted,lineHeight:1.6,marginBottom:24,maxWidth:280,margin:"0 auto 24px"}}>{props.ach.desc}</div>
      <button onClick={props.onClose} style={{padding:"10px 24px",borderRadius:10,background:"linear-gradient(135deg, "+rar.c+"22, "+rar.c2+"15)",border:"1px solid "+rar.c+"50",color:rar.c,cursor:"pointer",fontFamily:FF.mono,fontSize:11,fontWeight:500,letterSpacing:"0.18em",textTransform:"uppercase",boxShadow:"0 0 16px -4px "+rar.glow,position:"relative",zIndex:2}}>Continuar</button>
    </div>
  </div>;
}

function AchievementsPanel(props) {
  if (!props.open) return null;
  var unlocked = props.unlocked || {};
  var unlockedCount = Object.keys(unlocked).filter(function(k){return ACHIEVEMENTS.some(function(a){return a.id===k;});}).length;
  var pct = Math.round((unlockedCount / ACHIEVEMENTS.length) * 100);
  return <div onClick={props.onClose} style={{position:"fixed",inset:0,zIndex:1100,background:"rgba(0,0,0,0.30)",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(32px) saturate(1.5)",WebkitBackdropFilter:"blur(32px) saturate(1.5)",animation:"fadeIn 0.25s ease",padding:16}}>
    <div onClick={function(e){e.stopPropagation()}} className="modal-panel hud-card" style={{background:"linear-gradient(160deg, rgba(14,18,36,0.50), rgba(10,14,28,0.30))",border:"1px solid rgba(0,245,212,0.20)",borderRadius:20,padding:"24px 22px",maxWidth:640,width:"100%",maxHeight:"85vh",overflow:"auto",position:"relative",boxShadow:"0 60px 120px -30px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.08)",backdropFilter:"blur(48px) saturate(2)",WebkitBackdropFilter:"blur(48px) saturate(2)"}}>
      <div style={{position:"absolute",top:0,left:"15%",right:"15%",height:1,background:"linear-gradient(90deg, transparent, #00F5D4, #FF00E5, transparent)"}} />
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20,gap:14}}>
        <div>
          <div style={{fontFamily:FF.mono,fontSize:11,color:"#00F5D4",letterSpacing:"0.22em",textTransform:"uppercase",marginBottom:6}}>◇ trophies</div>
          <div className="serif-title" style={{fontSize:24,fontWeight:400,letterSpacing:"-0.015em",fontStyle:"italic"}}>Conquistas</div>
          <div style={{fontFamily:FF.mono,fontSize:12,color:T.muted,marginTop:4,letterSpacing:"0.08em"}}>{unlockedCount} de {ACHIEVEMENTS.length} desbloqueadas · {pct}%</div>
        </div>
        <button onClick={props.onClose} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",cursor:"pointer",padding:8,borderRadius:10,display:"flex"}}><X size={16} color={T.muted} /></button>
      </div>
      <div style={{position:"relative",height:4,background:"rgba(0,0,0,0.4)",borderRadius:2,overflow:"hidden",border:"1px solid rgba(0,245,212,0.18)",marginBottom:24}}>
        <div style={{position:"absolute",top:0,bottom:0,left:0,width:pct+"%",background:"linear-gradient(90deg, #00F5D4, #FF00E5)",borderRadius:2,boxShadow:"0 0 10px #00F5D4",transition:"width 1s cubic-bezier(0.2,0.8,0.2,1)"}} />
      </div>
      <div className="stagger-children" style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(140px, 1fr))",gap:10}}>
        {ACHIEVEMENTS.map(function(a){return <AchievementBadge key={a.id} ach={a} unlocked={!!unlocked[a.id]} size="auto" />;})}
      </div>
    </div>
  </div>;
}

function Sparkline(props) {
  var vals = props.values || [];
  if (vals.length < 2) return null;
  var w = props.w || 60;
  var h = props.h || 16;
  var min = Math.min.apply(null, vals);
  var max = Math.max.apply(null, vals);
  var range = max - min || 1;
  var points = vals.map(function(val, i) {
    var x = (i / (vals.length - 1)) * w;
    var y = h - ((val - min) / range) * (h - 3) - 1.5;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  var areaPoints = "0," + h + " " + points + " " + w + "," + h;
  var last = vals[vals.length - 1];
  var prev = vals[vals.length - 2];
  var up = last >= prev;
  var c = props.color || (up ? "#A8FF3E" : "#FF5A1F");
  var id = "sl" + Math.random().toString(36).slice(2, 7);
  var lastX = w;
  var lastY = h - ((last - min) / range) * (h - 3) - 1.5;
  return <svg width={w} height={h} style={{display:"block",flexShrink:0}}>
    <defs>
      <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stopColor={c} stopOpacity="0.35" />
        <stop offset="100%" stopColor={c} stopOpacity="0" />
      </linearGradient>
    </defs>
    <polygon points={areaPoints} fill={"url(#" + id + ")"} />
    <polyline points={points} fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" style={{filter:"drop-shadow(0 0 3px " + c + "CC)"}} />
    <circle cx={lastX} cy={lastY} r="2" fill={c} />
  </svg>;
}

function RingScore(props) {
  var size = props.size || 140;
  var stroke = props.stroke || 10;
  var rings = props.rings || [];
  var cx = size / 2;
  var cy = size / 2;
  var gap = stroke + 4;
  return <svg width={size} height={size} style={{display:"block"}}>
    {rings.map(function(r, i) {
      var radius = (size / 2) - (stroke / 2) - (i * gap);
      if (radius < 10) return null;
      var circ = 2 * Math.PI * radius;
      var pct = Math.max(0, Math.min(100, r.value || 0));
      var offset = circ - (pct / 100) * circ;
      var gid = "rg" + i + Math.random().toString(36).slice(2, 6);
      return <g key={i}>
        <defs>
          <linearGradient id={gid} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor={r.color} stopOpacity="1" />
            <stop offset="100%" stopColor={r.color2 || r.color} stopOpacity="0.7" />
          </linearGradient>
        </defs>
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke={r.color + "14"} strokeWidth={stroke} />
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke={"url(#" + gid + ")"} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset} transform={"rotate(-90 " + cx + " " + cy + ")"} style={{transition:"stroke-dashoffset 1s cubic-bezier(0.2,0.8,0.2,1)",filter:"drop-shadow(0 0 4px " + r.color + "99)"}} />
      </g>;
    })}
    {props.center && <g><text x={cx} y={cy - 4} textAnchor="middle" fontFamily="'Space Grotesk',sans-serif" fontSize={size * 0.22} fontWeight="400" fill="#fff" style={{letterSpacing:"-0.025em"}}>{props.center}</text><text x={cx} y={cy + 14} textAnchor="middle" fontFamily="'Geist Mono',monospace" fontSize={size * 0.075} fill="#93A3BC" style={{letterSpacing:"0.22em",textTransform:"uppercase"}}>score</text></g>}
  </svg>;
}

function EmptyState(props) {
  var c = props.color || "#00F5D4";
  var icon = props.icon || "chart";
  var icons = {
    chart: <svg width="80" height="60" viewBox="0 0 80 60" style={{display:"block"}}>
      <polyline points="5,50 20,38 35,44 50,22 65,30 75,12" stroke={c + "66"} strokeWidth="1.5" fill="none" strokeDasharray="3 3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="5" y1="55" x2="75" y2="55" stroke={c + "33"} strokeWidth="0.5" />
      <circle cx="50" cy="22" r="3" fill={c} opacity="0.7"><animate attributeName="r" values="3;5;3" dur="2s" repeatCount="indefinite" /></circle>
    </svg>,
    list: <svg width="80" height="60" viewBox="0 0 80 60" style={{display:"block"}}>
      <rect x="10" y="12" width="60" height="5" rx="2" fill={c + "33"} />
      <rect x="10" y="25" width="45" height="5" rx="2" fill={c + "22"} />
      <rect x="10" y="38" width="55" height="5" rx="2" fill={c + "22"} />
      <rect x="10" y="51" width="35" height="5" rx="2" fill={c + "14"} />
    </svg>,
    target: <svg width="72" height="72" viewBox="0 0 72 72" style={{display:"block"}}>
      <circle cx="36" cy="36" r="28" fill="none" stroke={c + "22"} strokeWidth="1" strokeDasharray="2 3" />
      <circle cx="36" cy="36" r="18" fill="none" stroke={c + "44"} strokeWidth="1" strokeDasharray="2 3" />
      <circle cx="36" cy="36" r="8" fill="none" stroke={c + "66"} strokeWidth="1.5" />
      <circle cx="36" cy="36" r="2" fill={c}><animate attributeName="opacity" values="0.4;1;0.4" dur="1.8s" repeatCount="indefinite" /></circle>
    </svg>
  };
  return <div style={{textAlign:"center",padding:"40px 20px",animation:"fadeUp 0.5s cubic-bezier(0.2,0.8,0.2,1)"}}>
    <div style={{display:"inline-block",marginBottom:14,opacity:0.8}}>{icons[icon]}</div>
    <div className="serif-title" style={{fontSize:20,fontStyle:"italic",color:"#93A3BC",marginBottom:6}}>{props.title || "Nada por aqui"}</div>
    <div style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:"#5B6A85",letterSpacing:"0.08em",marginBottom:14}}>{props.subtitle || "Adicione seu primeiro item"}</div>
    {props.action}
  </div>;
}

function CardFace(props) {
  var card = props.card || {};
  var b = getBankPreset(card);
  var fx = getCardBrandStyle(card);
  var last4 = String(card.limite || 0).replace(/\D/g,"").slice(-4).padStart(4,"0");
  var bandLower = String(card.band || "").toLowerCase();
  var isVisa = bandLower.indexOf("visa") >= 0;
  var isElo = bandLower.indexOf("elo") >= 0;
  var isMaster = bandLower.indexOf("master") >= 0;
  var isUltra = bandLower.indexOf("ultra") >= 0;
  var redeLabel = "CARD";
  if (isVisa) redeLabel = "VISA";
  else if (isMaster) redeLabel = "MASTERCARD";
  else if (isElo) redeLabel = "ELO";
  else if (isUltra) redeLabel = "ULTRA";
  var tierLabel = "";
  if (bandLower.indexOf("infinite") >= 0) tierLabel = "Infinite";
  else if (bandLower.indexOf("platinum") >= 0) tierLabel = "Platinum";
  else if (bandLower.indexOf("signature") >= 0) tierLabel = "Signature";
  else if (bandLower.indexOf("nanquim") >= 0) tierLabel = "Nanquim";
  else if (bandLower.indexOf("black") >= 0) tierLabel = "Black";
  else if (bandLower.indexOf("gold") >= 0) tierLabel = "Gold";
  var limTxt = (card.limite && card.limite >= 999999) ? "SEM LIMITE" : f$(card.limite || 0);
  var cardColor = card.cor || b.bg || "#1a1a2e";
  var cardColor2 = card.cor2 || b.ring || "#000";
  var gradStyle = "linear-gradient(135deg, "+cardColor+" 0%, "+cardColor2+" 50%, "+cardColor+"CC 100%)";
  return <div data-tilt="" style={{position:"relative",aspectRatio:"1.586",borderRadius:20,padding:22,overflow:"hidden",color:"#fff",background:gradStyle,boxShadow:"0 30px 70px -22px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 0 1px rgba(255,255,255,0.06)",transition:"transform .5s cubic-bezier(.2,.8,.2,1), box-shadow .5s",display:"flex",flexDirection:"column",cursor:"default",transformStyle:"preserve-3d",willChange:"transform"}}>
    <div style={{position:"absolute",inset:0,pointerEvents:"none",borderRadius:"inherit",background:"radial-gradient(600px circle at 20% 0%, rgba(255,255,255,0.22), transparent 45%), repeating-linear-gradient(135deg, rgba(255,255,255,0.025) 0 2px, transparent 2px 6px)"}} />
    <div style={{position:"absolute",top:"-50%",right:"-50%",width:"80%",height:"200%",pointerEvents:"none",background:"conic-gradient(from 180deg at 50% 50%, transparent 0%, rgba(255,255,255,0.08) 25%, transparent 50%)",animation:"rotSlow 18s linear infinite",mixBlendMode:"overlay"}} />
    <div style={{position:"relative",zIndex:2,display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
      <div style={{width:42,height:32,borderRadius:6,background:"linear-gradient(135deg, #E6D08A 0%, #C9A855 35%, #8A6B2E 70%, #C9A855 100%)",boxShadow:"0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.25)",opacity:0.85,position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",inset:"4px 6px",borderRadius:3,background:"repeating-linear-gradient(90deg, rgba(0,0,0,0.15) 0 2px, transparent 2px 4px), repeating-linear-gradient(0deg, rgba(0,0,0,0.15) 0 2px, transparent 2px 4px)"}} />
      </div>
      <div style={{textAlign:"right"}}>
        <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:14,letterSpacing:"-0.01em",lineHeight:1.1}}>{b.label}</div>
        {tierLabel && <div style={{fontFamily:"'Instrument Serif',serif",fontStyle:"italic",fontSize:13,marginTop:2,opacity:0.85,fontWeight:400}}>{tierLabel}</div>}
      </div>
    </div>
    <div style={{position:"relative",zIndex:2,marginTop:"auto",fontFamily:"'Geist Mono',monospace",fontSize:"clamp(13px, 2.2vw, 15px)",letterSpacing:"0.22em",opacity:0.92,fontWeight:500}}>{"•••• •••• •••• "+last4}</div>
    <div style={{position:"relative",zIndex:2,display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginTop:10,gap:10}}>
      <div style={{minWidth:0,flex:1}}>
        <div style={{fontFamily:"'Geist Mono',monospace",fontSize:11,letterSpacing:"0.22em",textTransform:"uppercase",opacity:0.65}}>titular</div>
        <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:500,fontSize:12,marginTop:3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{card.nome || "Cartão"}</div>
      </div>
      <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:13,letterSpacing:"0.08em",opacity:0.92,textShadow:"0 0 14px rgba(255,255,255,0.25)"}}>{redeLabel}</div>
    </div>
    <div style={{position:"relative",zIndex:2,marginTop:14,paddingTop:12,borderTop:"1px solid rgba(255,255,255,0.14)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontFamily:"'Geist Mono',monospace",fontSize:12}}>
        <span style={{opacity:0.75}}>limite</span>
        <span style={{fontWeight:600}}>{limTxt}</span>
      </div>
      <div style={{marginTop:6,height:3,borderRadius:2,background:"rgba(255,255,255,0.15)",overflow:"hidden"}}>
        <div style={{height:"100%",width:Math.min(100, ((card.usoPct||0))) + "%",borderRadius:"inherit",background:"rgba(255,255,255,0.85)",boxShadow:"0 0 10px rgba(255,255,255,0.6)",animation:"grow 1.1s cubic-bezier(.2,.8,.2,1) both",transformOrigin:"left"}} />
      </div>
      <div style={{marginTop:6,display:"flex",justifyContent:"space-between",fontFamily:"'Geist Mono',monospace",fontSize:11,opacity:0.65,letterSpacing:"0.08em",textTransform:"uppercase"}}>
        <span>fecha {card.fecha ? String(card.fecha).padStart(2,"0") : "--"}</span>
        <span>vence {card.venc ? String(card.venc).padStart(2,"0") : "--"}</span>
      </div>
    </div>
  </div>;
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function parseBR(r) {
  if (typeof r === "number") return r;
  var s = String(r).replace(/[R$\s]/g,"").trim();
  if (!s) return 0;
  if (s.indexOf(",") >= 0 && s.indexOf(".") >= 0) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g,"").replace(",",".");
    else s = s.replace(/,/g,"");
  } else if (s.indexOf(",") >= 0) {
    var p = s.split(",");
    if (p.length === 2 && p[1].length <= 2) s = s.replace(",",".");
    else s = s.replace(/,/g,"");
  }
  var n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n*100)/100;
}

function f$(v) { return "R$ " + Number(v||0).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fK(v) { var n = Number(v||0); return n >= 1000 ? "R$ "+(n/1000).toFixed(1)+"k" : f$(v); }
function pct(v) { return (v||0).toFixed(1)+"%"; }
function fD(d) { try { return new Date(d+"T12:00:00").toLocaleDateString("pt-BR"); } catch(e) { return ""; } }
function hj() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
function dAt(d) { return Math.max(0, Math.ceil((new Date(d) - new Date()) / 86400000)); }
function gMA(d) { var dt = new Date((d||hj())+"T12:00:00"); return { mes: dt.getMonth()+1, ano: dt.getFullYear() }; }

var CATS = [
  {id:"c1",nome:"Casa",tipo:"despesa",orc:0,emoji:"🏠",cor:"#3B82F6"},
  {id:"c2",nome:"Alimentação",tipo:"despesa",orc:0,emoji:"🍽️",cor:"#F97316"},
  {id:"c3",nome:"Assinaturas",tipo:"despesa",orc:0,emoji:"📱",cor:"#8B5CF6"},
  {id:"c4",nome:"Educação",tipo:"despesa",orc:0,emoji:"📚",cor:"#06B6D4"},
  {id:"c5",nome:"Saúde",tipo:"despesa",orc:0,emoji:"💊",cor:"#EF4444"},
  {id:"c6",nome:"Outros",tipo:"despesa",orc:0,emoji:"📦",cor:"#6B7280"},
  {id:"c7",nome:"Transporte",tipo:"despesa",orc:0,emoji:"🚗",cor:"#14B8A6"},
  {id:"c8",nome:"Dívidas",tipo:"despesa",orc:0,emoji:"💳",cor:"#DC2626"},
  {id:"c9",nome:"Mercado",tipo:"despesa",orc:0,emoji:"🛒",cor:"#22C55E"},
  {id:"c10",nome:"Salário",tipo:"receita",orc:0,emoji:"💰",cor:"#10B981"},
  {id:"c11",nome:"Dog",tipo:"despesa",orc:0,emoji:"🐕",cor:"#D97706"},
  {id:"c12",nome:"Academia",tipo:"despesa",orc:0,emoji:"🏋️",cor:"#7C3AED"},
  {id:"c13",nome:"Celular",tipo:"despesa",orc:0,emoji:"📲",cor:"#0EA5E9"},
  {id:"c14",nome:"Variáveis",tipo:"despesa",orc:0,emoji:"🔀",cor:"#EC4899"},
  {id:"c15",nome:"Anuidades",tipo:"despesa",orc:0,emoji:"💳",cor:"#F59E0B"},
  {id:"c16",nome:"Milhas",tipo:"despesa",orc:0,emoji:"✈️",cor:"#0EA5E9"}
];

function mkL() {
  var L = [];
  function a(dt,tp,cat,ds,vl,st,rec,pt,pa,pg,cartaoId) {
    var r = gMA(dt);
    var metodo = pg || (cartaoId ? "cartao" : "pix");
    L.push({id:uid(),data:dt,mes:r.mes,ano:r.ano,tipo:tp,cat:cat,desc:ds,valor:vl,status:st||"pago",cartaoId:cartaoId||"",pg:metodo,rec:!!rec,pT:pt||0,pA:pa||0});
  }
  // === RECEITA ===
  a("2026-03-25","receita","c10","Salário",21671,"pago",true);
  a("2026-04-25","receita","c10","Salário",21671,"pendente",true);
  // === DESPESAS FIXAS (31 itens = R$ 8.801,61) - todas recorrentes ===
  a("2026-04-01","despesa","c1","Aluguel",2800,"pendente",true);
  a("2026-04-01","despesa","c1","Luz",149.90,"pendente",true);
  a("2026-04-01","despesa","c1","Internet",129.90,"pendente",true);
  a("2026-04-01","despesa","c1","Água",80,"pendente",true);
  a("2026-04-01","despesa","c9","Supermercado",1400,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c9","Café Cápsulas",60,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c2","Gastos Saídas",700,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c7","Gasolina",620,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c13","Plano Pós",66,"pendente",true);
  a("2026-04-01","despesa","c13","Plano Pos Barbara",66,"pendente",true);
  a("2026-04-01","despesa","c6","Barbeiro",55,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c7","Lavagem Carro",50,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c16","Clube Curtai",44.90,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c4","Pós-Graduação",98,"pendente",true);
  a("2026-04-01","despesa","c11","Spike",250,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c3","TotalPass",139.90,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c3","TotalPass Barbara",119.90,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c3","Streaming",55.21,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c3","Cinemark",32.90,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c5","Ritalina+Venvanse",296,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c5","Medicamentos",84.04,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c4","Legis. Destacada",57.61,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c4","Tec Concursos",44.90,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c3","ChatGPT",100,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c3","iCloud+",19.90,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c3","Spotify",17.66,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c3","Claude",689,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c3","Santander Select",50,"pendente",true);
  a("2026-04-01","despesa","c3","Revolut Ultra",199.99,"pendente",true);
  a("2026-04-01","despesa","c3","Serasa Premium",23.90,"pendente",true);
  a("2026-04-01","despesa","c16","Revpoints 500",46.90,"pendente",true,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c15","Anuidade BRB",91,"pendente",false,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c4","Faculdade Barbara",764,"pendente",true,0,0,"cartao","cd1");
  // === DIVIDAS E PARCELAMENTOS (31 itens = R$ 4.776,81) ===
  // pT=total meses, pA=1 (primeiro mes)
  a("2026-04-01","parcela","c8","Acordo Serasa",96.36,"pendente",false,9,1,"pix","");
  a("2026-04-01","parcela","c8","Acordo Serasa 2",51.76,"pendente",false,9,1,"pix","");
  a("2026-04-01","parcela","c8","Amazon parc.",15.40,"pendente",false,2,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Bicicleta",115,"pendente",false,7,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Boticário",22.15,"pendente",false,7,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Dock Robô",57,"pendente",false,2,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Empr. Barbara Itaú",614,"pendente",false,9,1,"pix","");
  a("2026-04-01","parcela","c8","Ifood Parcela",541.81,"pendente",false,6,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Lacoste",190,"pendente",false,2,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Leroy Merlin",199.98,"pendente",false,8,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Levis",150,"pendente",false,3,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Parcelas Itaú",300,"pendente",false,9,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Perf. Azzaro",45.66,"pendente",false,7,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Perf. Invictus",37,"pendente",false,7,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Pintura",76.54,"pendente",false,9,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Rel. Invicta",81.20,"pendente",false,6,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Tampa Vaso",9.17,"pendente",false,9,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","UNIP",371,"pendente",false,5,1,"pix","");
  a("2026-04-01","parcela","c8","Viagem Fortaleza",50,"pendente",false,8,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Mercado Livre",11.83,"pendente",false,9,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Leroy Merlin 2",117.24,"pendente",false,4,1,"cartao","cd1");
  a("2026-04-01","parcela","c16","Livelo",102.12,"pendente",false,9,1,"cartao","cd1");
  a("2026-04-01","parcela","c16","Smiles",105,"pendente",false,3,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Estratégia Concursos",54.77,"pendente",false,9,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Hotel Spike",106.84,"pendente",false,9,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Rei Castanhas",62.83,"pendente",false,4,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Kindle",161.21,"pendente",false,9,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Decolar",133.35,"pendente",false,4,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","Aspirador Robô",209.57,"pendente",false,4,1,"cartao","cd1");
  a("2026-04-01","parcela","c8","SeaWorld",119.42,"pendente",false,6,1,"cartao","cd1");
  a("2026-05-01","parcela","c8","Rack",81.77,"pendente",false,12,1,"cartao","cd1");
  a("2026-05-01","parcela","c8","SSD PS5",97.91,"pendente",false,12,1,"cartao","cd1");
  a("2026-05-01","parcela","c8","Empréstimo Cartão BRB",241.44,"pendente",false,18,1,"cartao","cd1");
  a("2026-05-01","parcela","c8","Cafeteira",444.00,"pendente",false,12,1,"cartao","cd1");
  a("2026-05-01","parcela","c8","Pneu",73.00,"pendente",false,12,1,"cartao","cd1");
  a("2026-06-01","parcela","c8","Mecânico",450.00,"pendente",false,6,1,"cartao","cd1");
  // === DESPESAS VARIAVEIS ABRIL (8 itens = R$ 826,31) ===
  a("2026-04-01","despesa","c14","Amazon",28.79,"pendente",false,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c14","Amazon",73.56,"pendente",false,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c14","Amazon",34.90,"pendente",false,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c14","Presente Pai",30.06,"pendente",false,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c14","Renner",94,"pendente",false,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c14","Reserva",257,"pendente",false,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c14","Shopee",125,"pendente",false,0,0,"cartao","cd1");
  a("2026-04-01","despesa","c14","Dudalina",183,"pendente",false,0,0,"cartao","cd1");
  return L;
}

const DEF = {
  v: VER,
  investimentoFixo: 5000,
  contas: [{id:"ct1",nome:"Itaú Conta Corrente",saldo:0},{id:"ct2",nome:"Santander Conta Corrente",saldo:0},{id:"ct3",nome:"Bradesco Conta Corrente",saldo:0},{id:"ct4",nome:"Revolut Ultra",saldo:0}],
  lancamentos: mkL(),
  cartoes: [
    {id:"cd1",nome:"AAdvantage Platinum",band:"Mastercard Platinum",bankKey:"santander",emoji:"✈️",limite:11343,venc:27,fecha:3,cor:"#E11931",cor2:"#8B0000",visual:"executive",statusEstr:"concentrar_gastos",logoUrl:"",obs:"Cartao principal Santander",titular:"joao"},
    {id:"cd2",nome:"Revolut Ultra",band:"Visa Infinite",bankKey:"revolut",emoji:"⚡",limite:999999,venc:0,fecha:0,cor:"#0075EB",cor2:"#001A3A",visual:"fintech",statusEstr:"manter_estável",logoUrl:"",obs:"Sem limite definido",titular:"joao"},
    {id:"cd3",nome:"Itau Visa Platinum",band:"Visa Platinum",bankKey:"itau",emoji:"🟧",limite:18500,venc:27,fecha:3,cor:"#FF7A00",cor2:"#1D2A7A",visual:"executive",statusEstr:"manter_estável",logoUrl:"",obs:"",titular:"joao"},
    {id:"cd4",nome:"Bradesco Elo Nanquim",band:"Elo Nanquim",bankKey:"bradesco",emoji:"🔺",limite:5000,venc:27,fecha:3,cor:"#CC092F",cor2:"#4C0A17",visual:"black",statusEstr:"manter_estável",logoUrl:"",obs:"",titular:"joao"},
    {id:"cd5",nome:"Nubank",band:"Mastercard",bankKey:"nubank",emoji:"🟣",limite:5000,venc:10,fecha:3,cor:"#8A05BE",cor2:"#1A0030",visual:"fintech",statusEstr:"manter_estável",logoUrl:"",obs:"",titular:"barbara"},
    {id:"cd6",nome:"Mercado Pago",band:"Visa",bankKey:"mercadopago",emoji:"🤝",limite:3000,venc:10,fecha:3,cor:"#00B1EA",cor2:"#003A6B",visual:"fintech",statusEstr:"manter_estável",logoUrl:"",obs:"",titular:"barbara"},
    {id:"cd7",nome:"Will Bank",band:"Visa",bankKey:"will",emoji:"🟡",limite:2000,venc:10,fecha:3,cor:"#FFD200",cor2:"#8B7300",visual:"classic",statusEstr:"manter_estável",logoUrl:"",obs:"",titular:"barbara"},
    {id:"cd8",nome:"Itau Platinum Barbara",band:"Visa Platinum",bankKey:"itau",emoji:"🟧",limite:5000,venc:10,fecha:3,cor:"#FF7A00",cor2:"#1D2A7A",visual:"executive",statusEstr:"manter_estável",logoUrl:"",obs:"",titular:"barbara"},
    {id:"cd9",nome:"Itau Multiplo Barbara",band:"Visa",bankKey:"itau",emoji:"🟧",limite:3000,venc:10,fecha:3,cor:"#FF7A00",cor2:"#1D2A7A",visual:"classic",statusEstr:"manter_estável",logoUrl:"",obs:"",titular:"barbara"},
    {id:"cd10",nome:"Itau Visa Signature Barbara",band:"Visa Signature",bankKey:"itau",emoji:"🟧",limite:10000,venc:10,fecha:3,cor:"#FF7A00",cor2:"#1D2A7A",visual:"executive",statusEstr:"manter_estável",logoUrl:"",obs:"",titular:"barbara"},
    {id:"cd11",nome:"BTG Barbara",band:"Mastercard Black",bankKey:"btg",emoji:"🔵",limite:5000,venc:10,fecha:3,cor:"#0055A4",cor2:"#002244",visual:"black",statusEstr:"manter_estável",logoUrl:"",obs:"",titular:"barbara"},
    {id:"cd12",nome:"XP Barbara",band:"Visa",bankKey:"xp",emoji:"🟢",limite:3000,venc:10,fecha:3,cor:"#00C853",cor2:"#1A1A1A",visual:"black",statusEstr:"manter_estável",logoUrl:"",obs:"",titular:"barbara"}
  ],
  dividas: [
    {id:"d1",nome:"Empréstimo Barbara Itaú",total:7368,pago:0,parcela:614,pRest:12,vDia:1,taxa:1.5},
    {id:"d2",nome:"Parcelas Itaú",total:3600,pago:0,parcela:300,pRest:12,vDia:1,taxa:1.0},
    {id:"d3",nome:"Acordo Serasa",total:1156,pago:0,parcela:96.36,pRest:12,vDia:1,taxa:0},
    {id:"d4",nome:"Acordo Serasa 2",total:621,pago:0,parcela:51.76,pRest:12,vDia:1,taxa:0}
  ],
  investimentos: [
    {id:"i1",nome:"Renda Fixa Santander",valor:25000,rent:1.0,tipo:"cdb",banco:"santander",liquidez:"diaria",dataAplicacao:"2026-03-01",vencimento:""}
  ],
  metas: [
    {id:"m1",nome:"Meta R$ 35 mil",valor:35000,prazo:"2026-03-25",vinc:"invest"},
    {id:"m2",nome:"Meta R$ 52 mil",valor:52000,prazo:"2026-05-25",vinc:"invest"},
    {id:"m3",nome:"Meta R$ 100 mil",valor:100000,prazo:"2026-09-25",vinc:"invest"}
  ],
  categorias: CATS,
  ratingMensal: {},
  salarioDia: 25,
  faturasManuais: {
    "cd5|2026-05": {valorManual:1400},
    "cd3|2026-05": {valorManual:3000},
    "cd7|2026-05": {valorManual:342.23},
    "cd6|2026-05": {valorManual:298},
    "cd1|2026-05": {valorManual:3484.84},
    "cd10|2026-05": {valorManual:2283.83},
    "cd8|2026-05": {valorManual:46.68},
    "cd9|2026-05": {valorManual:81.23},
    "cd4|2026-05": {valorManual:78}
  }
};




function expandLançamentos(db) {
  var base = db.lancamentos;
  var extras = [];
  var existeChave = {};
  
  for (let i =0; i<base.length; i++) {
    var key = base[i].desc + "|" + base[i].mes + "|" + base[i].ano;
    existeChave[key] = true;
  }

  for (let j =0; j<base.length; j++) {
    var l = base[j];

    
    if (l.rec && l.tipo !== "receita") {
      for (let offset =1; offset<=12; offset++) {
        var nm = l.mes + offset;
        var na = l.ano;
        while (nm > 12) { nm -= 12; na++; }
        var chave = l.desc + "|" + nm + "|" + na;
        if (!existeChave[chave]) {
          var diaOrig = parseInt(l.data.slice(8,10),10) || 1;
          var diaMax = dimMes(nm, na);
          var diaSafe = Math.min(diaOrig, diaMax);
          var dt = na + "-" + (nm<10?"0":"") + nm + "-" + (diaSafe<10?"0":"") + diaSafe;
          extras.push({id:"vr_"+l.id+"_"+offset, data:dt, mes:nm, ano:na, tipo:l.tipo, cat:l.cat, desc:l.desc, valor:l.valor, status:"pendente", cartaoId:l.cartaoId||"", pg:l.pg||(l.cartaoId?"cartao":"pix"), rec:true, pT:l.pT, pA:l.pA, virtual:true});
          existeChave[chave] = true;
        }
      }
    }

    
    if (l.rec && l.tipo === "receita") {
      for (let ro =1; ro<=12; ro++) {
        var rm = l.mes + ro;
        var ra = l.ano;
        while (rm > 12) { rm -= 12; ra++; }
        var rchave = l.desc + "|" + rm + "|" + ra;
        if (!existeChave[rchave]) {
          var rDiaOrig = parseInt(l.data.slice(8,10),10) || 1;
          var rDiaMax = dimMes(rm, ra);
          var rDiaSafe = Math.min(rDiaOrig, rDiaMax);
          var rdt = ra + "-" + (rm<10?"0":"") + rm + "-" + (rDiaSafe<10?"0":"") + rDiaSafe;
          extras.push({id:"vr_"+l.id+"_"+ro, data:rdt, mes:rm, ano:ra, tipo:"receita", cat:l.cat, desc:l.desc, valor:l.valor, status:"pendente", cartaoId:"", pg:"pix", rec:true, pT:0, pA:0, virtual:true});
          existeChave[rchave] = true;
        }
      }
    }

    
    if (l.pT > 0 && l.pA > 0 && l.pA < l.pT) {
      for (let pk = l.pA + 1; pk <= l.pT; pk++) {
        var pm = l.mes + (pk - l.pA);
        var pa = l.ano;
        while (pm > 12) { pm -= 12; pa++; }
        var pchave = l.desc + "|" + pm + "|" + pa;
        if (!existeChave[pchave]) {
          var pDiaOrig = parseInt(l.data.slice(8,10),10) || 1;
          var pDiaMax = dimMes(pm, pa);
          var pDiaSafe = Math.min(pDiaOrig, pDiaMax);
          var pdt = pa + "-" + (pm<10?"0":"") + pm + "-" + (pDiaSafe<10?"0":"") + pDiaSafe;
          extras.push({id:"vp_"+l.id+"_"+pk, data:pdt, mes:pm, ano:pa, tipo:l.tipo, cat:l.cat, desc:l.desc+" "+pk+"/"+l.pT, valor:l.valor, status:"pendente", cartaoId:l.cartaoId||"", pg:l.pg||(l.cartaoId?"cartao":"pix"), rec:false, pT:l.pT, pA:pk, virtual:true});
          existeChave[pchave] = true;
        }
      }
    }
  }

  return base.concat(extras);
}

function getRes(db, m, a) {
  var rc=0, dp=0, pc=0, porC={};
  for (let i =0; i<db.lancamentos.length; i++) {
    var l = db.lancamentos[i];
    if (l.mes !== m || l.ano !== a) continue;
    if (l.tipo === "receita") rc += l.valor;
    else { dp += l.valor; if (l.tipo === "parcela") pc += l.valor; }
    if (l.tipo !== "receita") porC[l.cat] = (porC[l.cat]||0) + l.valor;
  }
  return { rc:rc, dp:dp, saldo:rc-dp, pc:pc, porC:porC };
}

function getDebtPayoffProjection(dividas, parcelas) {
  var projections = [];
  (dividas || []).forEach(function(d) {
    if (d.quitada) return;
    var rest = Math.max(0, (d.total || 0) - (d.pago || 0));
    var meses = d.parcela > 0 ? Math.ceil(rest / d.parcela) : 0;
    var dataQuit = new Date();
    dataQuit.setMonth(dataQuit.getMonth() + meses);
    projections.push({nome: d.nome, restante: rest, parcela: d.parcela, mesesRestantes: meses, dataQuitacao: dataQuit.getFullYear() + "-" + String(dataQuit.getMonth()+1).padStart(2,"0"), taxa: d.taxa || 0});
  });
  return projections.sort(function(a,b) { return a.mesesRestantes - b.mesesRestantes; });
}

function getPat(db) {
  var sc=0, inv=0, dv=0;
  for (let i =0; i<db.contas.length; i++) sc += db.contas[i].saldo || 0;
  for (let j =0; j<db.investimentos.length; j++) inv += db.investimentos[j].valor || 0;
  for (let k =0; k<db.dividas.length; k++) dv += Math.max(0, (db.dividas[k].total||0) - (db.dividas[k].pago||0));
  return { sc:sc, inv:inv, bruto:sc+inv, liq:sc+inv-dv, dv:dv };
}

function getVisaoAnual(db, anoRef) {
  var result = [];
  for (let m =1; m<=12; m++) {
    var pvM = getPrevisão(db, m, anoRef);
    var temDados = pvM.receitaMes > 0 || pvM.despLancadas > 0;
    result.push({ m:m, nome:MS[m-1], rc:pvM.receitaMes, dp:pvM.despTotalMes, saldo:pvM.sobraPrevista, temDados:temDados });
  }
  return result;
}

function getMetP(db) {
  var inv = 0;
  for (let i =0; i<db.investimentos.length; i++) inv += db.investimentos[i].valor || 0;
  return (db.metas||[]).map(function(m) {
    var pr = m.valor > 0 ? Math.min((inv/m.valor)*100, 100) : 0;
    var ft = Math.max(0, m.valor - inv);
    var dr = dAt(m.prazo);
    return { id:m.id, nome:m.nome, valor:m.valor, prazo:m.prazo, vinc:m.vinc, at:inv, pr:pr, ft:ft, dr:dr, aporte: ft/Math.max(1,dr/30) };
  });
}

function getAl(db, m, a) {
  var r = getRes(db, m, a);
  var pv = getPrevisão(db, m, a);
  var al = [];
  var tFixas = 0;
  for (let i =0; i<db.lancamentos.length; i++) {
    var l = db.lancamentos[i];
    if (l.mes === m && l.ano === a && l.rec && l.tipo !== "receita") tFixas += l.valor;
  }
  if (r.rc > 0 && r.dp > r.rc*0.9) al.push({s:"danger",t:"Despesas",m:"Despesas em "+pct(r.dp/r.rc*100)+" da receita",r:"Revise gastos"});
  if (r.rc > 0 && tFixas > r.rc*0.6) al.push({s:"warning",t:"Fixas",m:"Fixas: "+pct(tFixas/r.rc*100)+" da receita",r:"Tente reduzir"});
  if (r.saldo < 0) al.push({s:"danger",t:"Saldo",m:"Mês negativo: "+f$(r.saldo),r:"Corte despesas"});
  if (pv.orcTotal > 0 && pv.despLancadas > pv.orcTotal) al.push({s:"warning",t:"Orçamento",m:"Lançamentos excedem orçamento em "+f$(pv.despLancadas - pv.orcTotal),r:"Revise categorias"});
  if (pv.sobraPrevista < 0) al.push({s:"danger",t:"Projeção",m:"Sobra prevista negativa: "+f$(pv.sobraPrevista),r:"Corte despesas"});
  pv.porCat.forEach(function(c) {
    if (c.orc > 0 && c.projetado > c.orc * 1.2) al.push({s:"warning",t:"Categoria",m:c.nome+": "+pct(c.projetado/c.orc*100)+" do planejado",r:"Reduza "+c.nome});
  });
  var cards = getCardsResumo(db, m, a);
  var hoje = getRefDatePeriodo(m, a);
  cards.forEach(function(card) {
    if (card.usoRealPct > 50) al.push({s:"danger",t:"Cartao",m:card.nome+": uso real em "+pct(card.usoRealPct),r:"Reduza compras ou antecipe pagamentos"});
    else if (card.usoRealPct > 30) al.push({s:"warning",t:"Cartao",m:card.nome+": uso real em "+pct(card.usoRealPct),r:"Evite ultrapassar 30%"});
    card.faturas.forEach(function(f) {
      var dias = Math.ceil((f.vencDate - hoje)/86400000);
      if (!f.paga && f.total > 0 && dias < 0) al.push({s:"danger",t:"Fatura",m:card.nome+" vencida desde "+fD(isoDt(f.vencDate)),r:"Regularize esta fatura"});
      else if (!f.paga && f.total > 0 && dias <= 3) al.push({s:"warning",t:"Fatura",m:card.nome+" vence em "+Math.max(0,dias)+" dia(s)",r:"Programe o pagamento"});
      if (Math.abs(f.divergencia) >= 0.01) al.push({s:"warning",t:"Conciliação",m:card.nome+" "+f.titulo+" com divergencia de "+f$(f.divergencia),r:"Confira valor manual x lancamentos"});
    });
  });
  (db.lancamentos||[]).forEach(function(l) {
    if (l.mes === m && l.ano === a && l.tipo !== "receita" && getMetodoPg(l) === "cartao" && !(l.cartaoId||"")) al.push({s:"danger",t:"Lançamento",m:"Compra em cartão sem cartão vinculado",r:"Edite o lançamento e vincule o cartão"});
  });
  return al;
}

function getPrevisão(db, m, a) {
  var cats = (db.categorias||[]).filter(function(c){return c.tipo === "despesa"});
  var lancMes = (db.lancamentos||[]).filter(function(l){return l.mes===m && l.ano===a && l.tipo!=="receita"});

  var receitaMes = 0;
  for (let i =0; i<db.lancamentos.length; i++) {
    if (db.lancamentos[i].mes===m && db.lancamentos[i].ano===a && db.lancamentos[i].tipo==="receita") receitaMes += db.lancamentos[i].valor;
  }

  var orcTotal = 0;
  for (let j =0; j<cats.length; j++) orcTotal += cats[j].orc || 0;

  var despLancadas = 0;
  for (let t =0; t<lancMes.length; t++) despLancadas += lancMes[t].valor;

  var porCat = cats.map(function(c) {
    var realizado = 0, pendente = 0;
    for (let k =0; k<lancMes.length; k++) {
      if (lancMes[k].cat === c.id) {
        if (lancMes[k].status === "pago") realizado += lancMes[k].valor;
        else pendente += lancMes[k].valor;
      }
    }
    var lancado = realizado + pendente;
    var devR = (c.orc||0) > 0 ? (c.orc||0) - lancado : 0;
    var devP = (c.orc||0) > 0 ? ((lancado / (c.orc||1)) * 100) - 100 : 0;
    return {id:c.id, nome:c.nome, orc:c.orc||0, realizado:realizado, pendente:pendente, lancado:lancado, projetado:lancado, desvioR:devR, desvioP:devP};
  });

  var despTotalMes = despLancadas;
  var sobraPrevista = receitaMes - despTotalMes;
  var investFixo = db.investimentoFixo || 0;
  var aindaPodeGastar = Math.max(0, sobraPrevista - investFixo);

  return {porCat:porCat, orcTotal:orcTotal, despLancadas:despLancadas, despTotalMes:despTotalMes, sobraPrevista:sobraPrevista, investFixo:investFixo, aindaPodeGastar:aindaPodeGastar, receitaMes:receitaMes, sobra:sobraPrevista, recTotal:receitaMes, despTotal:despTotalMes};
}

function getMetodoPg(l) {
  if (!l || l.tipo === "receita") return "pix";
  return l.pg || (l.cartaoId ? "cartao" : "pix");
}

function addMesRef(m, a, off) {
  var nm = m + off;
  var na = a;
  while (nm > 12) { nm -= 12; na++; }
  while (nm < 1) { nm += 12; na--; }
  return {mes:nm, ano:na};
}

function dimMes(m, a) { return new Date(a, m, 0).getDate(); }

function mkDt(a, m, d) {
  return new Date(a, m-1, Math.min(d || 1, dimMes(m, a)), 12, 0, 0, 0);
}

function isoDt(dt) {
  return dt.getFullYear() + "-" + String(dt.getMonth()+1).padStart(2,"0") + "-" + String(dt.getDate()).padStart(2,"0");
}

function getFaturaRef(l, card) {
  var dt = new Date((l.data || hj()) + "T12:00:00");
  var dia = dt.getDate();
  var mes = dt.getMonth() + 1;
  var ano = dt.getFullYear();
  if (dia > (card.fecha || 31)) {
    var nx = addMesRef(mes, ano, 1);
    mes = nx.mes; ano = nx.ano;
  }
  return {mes:mes, ano:ano, key:ano + "-" + String(mes).padStart(2,"0")};
}

function fatManualKey(cardId, mes, ano) {
  return String(cardId||"") + "|" + ano + "-" + String(mes).padStart(2,"0");
}

function getFatManual(db, cardId, mes, ano) {
  var all = db && db.faturasManuais ? db.faturasManuais : {};
  return all[fatManualKey(cardId, mes, ano)] || {};
}

function hasFatManualValor(meta) {
  return meta && meta.valorManual !== undefined && meta.valorManual !== null && meta.valorManual !== "";
}

function getFluxoFinanceiro(db, m, a) {
  var receita = 0, receitaPaga = 0, pix = 0, pixPago = 0, cartaoLanc = 0, cartaoLancPago = 0;
  for (let i =0; i<db.lancamentos.length; i++) {
    var l = db.lancamentos[i];
    if (l.mes !== m || l.ano !== a) continue;
    if (l.tipo === "receita") {
      receita += l.valor || 0;
      if (l.status === "pago") receitaPaga += l.valor || 0;
    } else {
      var metodo = getMetodoPg(l);
      var temCartaoVinculado = metodo === "cartao" && (l.cartaoId || "");
      if (temCartaoVinculado) {
        cartaoLanc += l.valor || 0;
        if (l.status === "pago") cartaoLancPago += l.valor || 0;
      } else {
        pix += l.valor || 0;
        if (l.status === "pago") pixPago += l.valor || 0;
      }
    }
  }
  var cards = getCardsResumo(db, m, a);
  var faturaDoMes = 0, faturaPaga = 0;
  cards.forEach(function(c) {
    var fatMes = c && c.faturas && c.faturas[0] ? c.faturas[0] : null;
    if (fatMes) {
      faturaDoMes += fatMes.total || 0;
      if (fatMes.paga) {
        faturaPaga += fatMes.meta && fatMes.meta.pagoValor !== undefined ? parseBR(fatMes.meta.pagoValor) : (fatMes.total || 0);
      }
    }
  });
  
  var sobraRealizada = receita - pix - faturaDoMes;
  
  var investFixo = db.investimentoFixo || 0;
  var ateSalario = sobraRealizada - investFixo;
  return {
    receita:receita,
    receitaPaga:receitaPaga,
    pix:pix,
    pixPago:pixPago,
    cartaoLanc:cartaoLanc,
    cartaoLancPago:cartaoLancPago,
    faturaDoMes:faturaDoMes,
    faturaPaga:faturaPaga,
    despLancadas:pix + cartaoLanc,
    cartao:faturaDoMes,
    cartaoPago:faturaPaga,
    sobraPrevista:sobraRealizada,
    sobraRealizada:sobraRealizada,
    investFixo:investFixo,
    ateSalario:ateSalario
  };
}

function getCardsResumo(db, m, a) {
  var cards = Array.isArray(db.cartoes) ? db.cartoes : [];
  return cards.map(function(card) {
    var gastosMes = 0;
    var grupos = [0,1,2].map(function(off) {
      var ref = addMesRef(m, a, off);
      var meta = getFatManual(db, card.id, ref.mes, ref.ano);
      var vencDia = parseInt(meta.vencDia) || (card.venc || 1);
      return {
        key:off===0?"atual":off===1?"prox1":"prox2",
        titulo:off===0?"Fatura atual":off===1?"Proxima fatura":"2a proxima",
        mes:ref.mes,
        ano:ref.ano,
        total:0,
        totalAuto:0,
        itens:[],
        vencDia:vencDia,
        vencDate:mkDt(ref.ano, ref.mes, vencDia),
        paga:!!meta.paga,
        manual:hasFatManualValor(meta),
        valorManual:meta.valorManual,
        pagoEm:meta.pagoEm || "",
        pagoValor:meta.pagoValor,
        pagoVencOriginal:meta.pagoVencOriginal || "",
        meta:meta,
        divergencia:0
      };
    });
    for (let i =0; i<db.lancamentos.length; i++) {
      var l = db.lancamentos[i];
      if (l.tipo === "receita") continue;
      if (getMetodoPg(l) !== "cartao") continue;
      if ((l.cartaoId || "") !== card.id) continue;
      if (l.mes === m && l.ano === a) gastosMes += l.valor || 0;
      var refFat = getFaturaRef(l, card);
      for (let g =0; g<grupos.length; g++) {
        var grp = grupos[g];
        if (grp.mes === refFat.mes && grp.ano === refFat.ano) {
          grp.totalAuto += l.valor || 0;
          grp.total += l.valor || 0;
          grp.itens.push(l);
        }
      }
    }
    grupos.forEach(function(g){
      g.itens.sort(function(a,b){ return a.data < b.data ? -1 : a.data > b.data ? 1 : 0; });
      if (g.manual) g.total = parseBR(g.valorManual);
      g.vencDate = mkDt(g.ano, g.mes, g.vencDia);
      g.divergencia = (g.total || 0) - (g.totalAuto || 0);
      g.conciliado = Math.abs(g.divergencia) < 0.01;
    });
    var limite = card.limite || 0;
    var comprometido = grupos.filter(function(g){ return !g.paga; }).reduce(function(s,g){ return s + (g.total || 0); }, 0);
    var historicoPagas = Object.keys(db.faturasManuais || {}).filter(function(k){ return k.indexOf(String(card.id||"") + "|") === 0; }).map(function(k) {
      var meta = db.faturasManuais[k] || {};
      if (!meta.paga) return null;
      var ym = k.split("|")[1] || "";
      var pa = parseInt(ym.slice(0,4),10) || a;
      var pm = parseInt(ym.slice(5,7),10) || m;
      return { key:k, mes:pm, ano:pa, ref:MSF[pm-1] + "/" + pa, valor:meta.pagoValor !== undefined ? parseBR(meta.pagoValor) : (hasFatManualValor(meta) ? parseBR(meta.valorManual) : 0), pagoEm:meta.pagoEm || "", vencOriginal:meta.pagoVencOriginal || "" };
    }).filter(Boolean).sort(function(x,y){ return (y.ano*100+y.mes) - (x.ano*100+x.mes); });
    return {
      id:card.id,
      nome:card.nome,
      band:card.band,
      bankKey:card.bankKey || inferBankKey(card.nome),
      logoUrl:card.logoUrl || "",
      emoji:card.emoji || "",
      visual:card.visual || "black",
      statusEstr:card.statusEstr || "manter_estável",
      limite:limite,
      venc:card.venc || 1,
      fecha:card.fecha || 31,
      cor:card.cor || T.blue,
      cor2:card.cor2 || "",
      obs:card.obs || "",
      titular:card.titular || "joao",
      gastosMes:gastosMes,
      usoPct:limite > 0 ? (gastosMes/limite)*100 : 0,
      livre:Math.max(0, limite - gastosMes),
      comprometido:comprometido,
      livreReal:Math.max(0, limite - comprometido),
      usoRealPct:limite > 0 ? (comprometido/limite)*100 : 0,
      faturaAtual:grupos[0].total,
      proxFatura:grupos[1].total,
      segundaFatura:grupos[2].total,
      faturas:grupos,
      historicoPagas:historicoPagas
    };
  });
}

function getRefDatePeriodo(m, a) {
  var now = new Date();
  if (now.getMonth()+1 === m && now.getFullYear() === a) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  return new Date(a, m-1, 1, 12, 0, 0, 0);
}

function getProxSalarioInfo(db, m, a, salarioDia) {
  var sd = salarioDia || 25;
  var ref = getRefDatePeriodo(m, a);
  var prox = mkDt(ref.getFullYear(), ref.getMonth()+1, sd);
  if (ref.getDate() >= sd) prox = mkDt(ref.getMonth()===11 ? ref.getFullYear()+1 : ref.getFullYear(), ref.getMonth()===11 ? 1 : ref.getMonth()+2, sd);
  var caixaBase = 0, receitas = 0, despDiretas = 0;
  for (let i =0; i<db.lancamentos.length; i++) {
    var l = db.lancamentos[i];
    var dt = new Date((l.data || hj()) + "T12:00:00");
    var isCartaoVinculado = getMetodoPg(l) === "cartao" && (l.cartaoId || "");
    if (dt < ref) {
      if (l.tipo === "receita" && l.status === "pago") caixaBase += l.valor || 0;
      
      if (l.tipo !== "receita" && !isCartaoVinculado && l.status === "pago") caixaBase -= l.valor || 0;
    }
    if (dt >= ref && dt <= prox) {
      if (l.tipo === "receita") receitas += l.valor || 0;
      
      if (l.tipo !== "receita" && !isCartaoVinculado) despDiretas += l.valor || 0;
    }
  }
  var cards = getCardsResumo(db, m, a);
  var faturas = 0;
  cards.forEach(function(c) {
    c.faturas.forEach(function(f) {
      if (f.vencDate >= ref && f.vencDate <= prox && !f.paga) faturas += f.total || 0;
    });
  });
  return {ref:ref, proximoSalario:prox, caixaBase:caixaBase, receitas:receitas, pix:despDiretas, faturas:faturas, sobra:caixaBase + receitas - despDiretas - faturas};
}

function getCalendarioFinanceiro(db, m, a, salarioDia) {
  var eventos = [];
  var sd = salarioDia || 25;
  eventos.push({id:"salario-"+m+"-"+a, dia:sd, data:mkDt(a, m, sd), titulo:"Salário", subtitulo:"Entrada principal do mês", cor:T.green, tag:"salario"});
  eventos.push({id:"aporte-"+m+"-"+a, dia:Math.min(sd + 1, dimMes(m, a)), data:mkDt(a, m, Math.min(sd + 1, dimMes(m, a))), titulo:"Aporte ideal", subtitulo:"Janela sugerida para aporte Santander", cor:T.cyan, tag:"aporte"});
  eventos.push({id:"janela-"+m+"-"+a, dia:Math.min(sd + 5, dimMes(m, a)), data:mkDt(a, m, Math.min(sd + 5, dimMes(m, a))), titulo:"Janela de consulta", subtitulo:"Bom momento para avaliar ofertas/pre-aprovados", cor:T.gold, tag:"cartao"});
  (db.cartoes || []).forEach(function(card) {
    eventos.push({id:card.id+"-fecha-"+m+"-"+a, dia:card.fecha || 1, data:mkDt(a, m, card.fecha || 1), titulo:"Fechamento " + (card.nome || "Cartao"), subtitulo:"Compras após esta data migram de ciclo", cor:card.cor || T.blue, tag:"fechamento"});
    eventos.push({id:card.id+"-venc-"+m+"-"+a, dia:card.venc || 1, data:mkDt(a, m, card.venc || 1), titulo:"Vencimento " + (card.nome || "Cartao"), subtitulo:"Fatura principal do cartao", cor:card.cor || T.blue, tag:"fatura"});
  });
  return eventos.sort(function(x,y){ return x.data - y.data; });
}

function getRatingSnapshot(db, m, a, salarioDia, ratingMensal) {
  var tasks = getRatingTasks();
  var cards = getCardsResumo(db, m, a);
  var fluxo = getFluxoFinanceiro(db, m, a);
  var prox = getProxSalarioInfo(db, m, a, salarioDia || 25);
  var key = a + "-" + (m<10?"0":"") + m;
  var mesRating = (ratingMensal && ratingMensal[key]) || {};
  var checklist = tasks.reduce(function(s,t){ return s + (mesRating[t.id] ? 8.75 : 0); }, 0);
  var totalLimites = cards.reduce(function(s,c){ return s + (c.limite||0); }, 0);
  var comprometido = cards.reduce(function(s,c){ return s + (c.comprometido||0); }, 0);
  var usoTotal = totalLimites > 0 ? (comprometido/totalLimites)*100 : 0;
  var auto = 0;
  var motivos = [];
  if (usoTotal > 0 && usoTotal <= 30) { auto += 8; motivos.push({tipo:"ok", txt:"Uso agregado do limite sob controle"}); }
  else if (usoTotal > 30 && usoTotal <= 50) { auto += 4; motivos.push({tipo:"warn", txt:"Uso agregado em faixa de atenção"}); }
  else if (usoTotal > 50) motivos.push({tipo:"bad", txt:"Uso agregado do limite acima do ideal"});
  if (fluxo.sobraPrevista >= 0) { auto += 7; motivos.push({tipo:"ok", txt:"Sobra prevista positiva"}); } else motivos.push({tipo:"bad", txt:"Sobra prevista negativa"});
  if (fluxo.sobraRealizada >= 0) { auto += 5; motivos.push({tipo:"ok", txt:"Sobra realizada positiva"}); } else motivos.push({tipo:"warn", txt:"Sobra realizada apertada"});
  if (prox.sobra >= 0) { auto += 5; motivos.push({tipo:"ok", txt:"Folga ate o proximo salario"}); } else motivos.push({tipo:"bad", txt:"Pressao no caixa ate o proximo salario"});
  if (cards.length === 0 || cards.every(function(c){ return c.usoPct <= 30; })) auto += 5;
  auto = Math.min(30, auto);
  var score = Math.round(Math.min(100, checklist + auto));
  var color = score >= 85 ? T.green : score >= 70 ? T.gold : T.red;
  return {key:key, checklist:checklist, auto:auto, usoTotal:usoTotal, score:score, color:color, motivos:motivos, fluxo:fluxo, prox:prox, cards:cards};
}

function getRatingTasks() {
  return [
    {id:"salario", titulo:"Receber salario no Santander", desc:"Manter a principal entrada recorrente no banco fortalece relacionamento e estabilidade."},
    {id:"almofada", titulo:"Manter almofada estável em conta", desc:"Evite zerar a conta logo após o crédito do salario."},
    {id:"aporte", titulo:"Fazer aporte mensal no Santander", desc:"Aporte recorrente sinaliza capacidade financeira e vinculo."},
    {id:"fatura", titulo:"Pagar fatura integral no vencimento", desc:"Nada de mínimo, rotativo ou parcelamento de fatura."},
    {id:"uso", titulo:"Usar limite com moderação", desc:"O ideal é manter uso saudável, sem pressão excessiva por vários ciclos."},
    {id:"pix", titulo:"Concentrar movimentação real", desc:"Pix, contas e despesas recorrentes ajudam na leitura de relacionamento."},
    {id:"ofertas", titulo:"Consultar ofertas em janelas estratégicas", desc:"Evite tentativas repetidas e seguidas de cartão ou upgrade."},
    {id:"cadastro", titulo:"Manter renda e cadastro coerentes", desc:"Dados atualizados e consistentes fortalecem a analise."}
  ];
}

function getRatingDonts() {
  return [
    "Não atrasar fatura, boleto, débito automático ou empréstimo.",
    "Não entrar no rotativo, cheque especial ou parcelar fatura.",
    "Não solicitar cartao, upgrade ou nova analise varias vezes em curto prazo.",
    "Não zerar completamente o saldo logo após o salario cair.",
    "Não usar limite alto demais por varios ciclos seguidos.",
    "Não deixar renda, cadastro e Open Finance incoerentes.",
    "Não movimentar valores artificiais so para parecer renda.",
    "Não alternar relacionamento bancário sem estratégia clara."
  ];
}

function somaBanco(lista, bankKey) {
  return (lista || []).reduce(function(s, item) {
    return inferBankKey(item.nome || item.label || "") === bankKey ? s + (item.valor !== undefined ? item.valor : (item.saldo || 0)) : s;
  }, 0);
}
function getCardBanco(cards, bankKey) {
  for (let i =0; i<(cards||[]).length; i++) {
    var c = cards[i];
    if ((c.bankKey || inferBankKey(c.nome)) === bankKey) return c;
  }
  return null;
}
function boolItem(label, ok, detail) {
  return {label:label, ok:!!ok, detail:detail||""};
}
function pctSafe(v) { return isFinite(v) ? pct(v) : "0.0%"; }
function getBankPlan(db, m, a, bankKey, salarioDia, ratingMensal) {
  var cards = getCardsResumo(db, m, a);
  var atual = getCardBanco(cards, bankKey);
  var fluxo = getFluxoFinanceiro(db, m, a);
  var prox = getProxSalarioInfo(db, m, a, salarioDia || 25);
  var contaBanco = somaBanco(db.contas, bankKey);
  var invBanco = somaBanco(db.investimentos, bankKey);
  var contaSant = somaBanco(db.contas, "santander") + somaBanco(db.investimentos, "santander");
  var contaItau = somaBanco(db.contas, "itau") + somaBanco(db.investimentos, "itau");
  var hoje = getRefDatePeriodo(m, a);
  var receitaMes = getRes(db, m, a).rc;
  var uso = atual ? (atual.usoRealPct || 0) : 0;
  var faturaAtual = atual && atual.faturas && atual.faturas[0] ? atual.faturas[0] : null;
  var pagamentoIntegral = !faturaAtual || faturaAtual.total <= 0 || !!faturaAtual.paga;
  var semAtraso = !atual || atual.faturas.every(function(f){ return f.paga || f.total <= 0 || f.vencDate >= hoje; });
  var semRotativo = pagamentoIntegral && semAtraso;
  var constancia = (db.lancamentos || []).some(function(l){ return l.tipo === "receita" && l.rec; }) && (db.lancamentos || []).some(function(l){ return l.tipo !== "receita" && l.rec; });
  var consultasPlanejadas = Math.abs((hoje.getDate() || 1) - ((salarioDia || 25) + 5)) <= 6;
  var alertas = [];
  var positivas = [];
  var actions = [];
  var avoid = bankKey === "santander" ? [
    "Não receber salario e esvaziar a conta imediatamente.",
    "Não enfraquecer saldo médio perto da analise.",
    "Não repetir pedidos de cartão em sequência curta.",
    "Não pressionar o limite perto do fechamento.",
    "Não deixar o relacionamento principal sem constancia."
  ] : [
    "Não pedir upgrade em momento de uso alto do limite.",
    "Não manter investimento desalinhado com a estrategia.",
    "Não insistir no upgrade sem melhora de base.",
    "Não ignorar ofertas no app e movimentos de limite.",
    "Não baguncar a coerência entre renda, gasto e limite."
  ];
  var ratingMesAtual = (ratingMensal||{})[(a + "-" + String(m).padStart(2,"0"))] || {};
  var salarioOk = bankKey === "santander" ? (receitaMes > 0 && (contaBanco > 0 || invBanco > 0 || ratingMesAtual.salario)) : (receitaMes > 0 && (invBanco > 0 || !!atual));
  var almofadaMin = bankKey === "santander" ? contaBanco >= 6000 : invBanco >= 10000;
  var almofadaIdeal = bankKey === "santander" ? contaBanco >= 8000 : invBanco >= 20000;
  var aporteMensal = bankKey === "santander" ? invBanco > 0 : invBanco > 0;
  var usoSaudavel = uso > 0 && uso <= 30;
  var usoAtencao = uso > 30 && uso <= 50;
  var concentracao = bankKey === "santander" ? contaSant >= contaItau : contaItau >= 15000 || invBanco > 0;
  var openFinanceOk = bankKey === "itau" ? (invBanco > 0 || !!atual) : true;
  var janelaIdeal = bankKey === "santander" ? "Preferir analisar ofertas entre 3 e 7 dias após o salario, com saldo médio preservado e sem estresse de caixa." : "Preferir avaliar upgrade alguns dias após o pagamento integral, com uso de limite controlado e base coerente.";
  var momentoRuim = bankKey === "santander" ? "Evite tentar quando a sobra do mês estiver pressionada, o saldo médio estiver fraco ou houver uso alto do limite." : "Evite solicitar upgrade com uso alto do limite, investimento desalinhado ou logo após negação recente.";
  var checks = bankKey === "santander" ? [
    boolItem("Salario no Santander", salarioOk, "Entrada principal organizada no banco foco."),
    boolItem("Almofada minima mantida", almofadaMin, "Meta orientativa de ao menos R$ 6 mil."),
    boolItem("Almofada ideal mantida", almofadaIdeal, "Meta orientativa de ao menos R$ 8 mil."),
    boolItem("Aporte mensal realizado", aporteMensal, "Investimento recorrente reforca relacionamento."),
    boolItem("Uso saudável do cartao Santander", usoSaudavel || !atual, atual ? pctSafe(uso) : "Sem cartão Santander cadastrado"),
    boolItem("Fatura integral paga", pagamentoIntegral, faturaAtual ? f$(faturaAtual.total || 0) : "Sem fatura no periodo"),
    boolItem("Sem atraso", semAtraso, "Sem faturas vencidas em aberto."),
    boolItem("Sem rotativo", semRotativo, "O app assume boa pratica quando ha pagamento integral e sem atraso."),
    boolItem("Constancia de movimentação", constancia, "Receitas e despesas recorrentes organizadas."),
    boolItem("Consulta em janela planejada", consultasPlanejadas, "Evita excesso de tentativas."),
    boolItem("Concentracao de relacionamento", concentracao, "Relacionamento mais robusto no banco foco.")
  ] : [
    boolItem("Investimento mantido ou ampliado", invBanco > 0, "Base de investimento no Itaú visivel no app."),
    boolItem("Uso consistente do cartão Itaú", !!atual, atual ? pctSafe(uso) : "Cadastre o cartão Itaú para monitorar"),
    boolItem("Uso saudável do limite", usoSaudavel || !atual, atual ? pctSafe(uso) : "Sem cartão no período"),
    boolItem("Fatura integral paga", pagamentoIntegral, faturaAtual ? f$(faturaAtual.total || 0) : "Sem fatura no periodo"),
    boolItem("Sem atraso", semAtraso, "Sem faturas vencidas em aberto."),
    boolItem("Sem rotativo", semRotativo, "Heuristica interna do app, nao score oficial."),
    boolItem("Upgrade em momento adequado", consultasPlanejadas && (uso <= 35 || !atual), "Momento sem pressão de caixa e de limite."),
    boolItem("Open Finance coerente", openFinanceOk, "Indicador interno apenas orientativo."),
    boolItem("Coerência renda, limite e gasto", receitaMes > 0 && (uso <= 40 || !atual), atual ? "Limite comprometido em faixa gerenciável." : "Sem cartão no período")
  ];
  var score = 0;
  checks.forEach(function(item) { score += item.ok ? (100 / checks.length) : 0; });
  if (usoAtencao) score -= 4;
  if (fluxo.sobraPrevista < 0) score -= 8;
  if (prox.sobra < 0) score -= 6;
  score = Math.max(0, Math.min(100, Math.round(score)));
  checks.forEach(function(item){ if (item.ok) positivas.push(item.label); else alertas.push(item.label); });
  if (!salarioOk && bankKey === "santander") actions.push("Fortalecer a leitura de relacionamento principal no Santander neste mês.");
  if (!almofadaMin && bankKey === "santander") actions.push("Recompor almofada minima antes de nova tentativa de cartao.");
  if (!almofadaIdeal && bankKey === "santander") actions.push("Buscar almofada ideal para melhorar estabilidade percebida.");
  if (!aporteMensal) actions.push(bankKey === "santander" ? "Registrar aporte mensal no banco foco." : "Manter ou ampliar base de investimento no Itaú.");
  if (uso > 30 && atual) actions.push("Reduzir uso do limite para faixa mais saudável antes de nova solicitação.");
  if (!pagamentoIntegral && atual) actions.push("Priorizar pagamento integral da fatura atual antes de qualquer pedido.");
  if (!semAtraso && atual) actions.push("Regularizar faturas vencidas e restaurar disciplina operacional.");
  if (bankKey === "itau" && !openFinanceOk) actions.push("Reforçar coerência operacional do Itaú antes de tentar upgrade.");
  if (!actions.length) actions.push(bankKey === "santander" ? "Manter consistência do relacionamento e testar oferta apenas em janela planejada." : "Manter base estável e observar upgrade em janela adequada.");
  return {
    bankKey:bankKey,
    nome:bankKey === "santander" ? "PLANO SANTANDER UNLIMITED" : "PLANO ITAÚ THE ONE",
    score:score,
    card:atual,
    contaBanco:contaBanco,
    invBanco:invBanco,
    usoPct:uso,
    faturaAtual:faturaAtual ? (faturaAtual.total || 0) : 0,
    pagamentoIntegral:pagamentoIntegral,
    semAtraso:semAtraso,
    semRotativo:semRotativo,
    consultasPlanejadas:consultasPlanejadas,
    checks:checks,
    actions:actions,
    avoid:avoid,
    sinaisPositivos:positivas.slice(0, 5),
    sinaisAlerta:alertas.slice(0, 5),
    janelaIdeal:janelaIdeal,
    momentoRuim:momentoRuim,
    resumo:bankKey === "santander" ? "Modelo orientativo para fortalecer relacionamento, saldo médio, aporte e disciplina de fatura no Santander." : "Modelo orientativo para melhorar coerência de base, uso de limite e timing de upgrade no Itaú."
  };
}
function getStrategicFocus(planoSant, planoItau, fluxo, als, cardsResumo, bancoFocoManual) {
  var bancoFocoAuto = planoSant.score <= planoItau.score ? "Santander" : "Itaú";
  var bancoFoco = bancoFocoManual || bancoFocoAuto;
  var plano = bancoFoco === "Santander" ? planoSant : planoItau;
  var criticos = (als || []).filter(function(a){ return a.s === "danger"; }).length;
  var risco = criticos > 0 ? (als.filter(function(a){ return a.s === "danger"; })[0] || {}).m : (fluxo.sobraPrevista < 0 ? "Sobra prevista negativa no mes." : (plano.sinaisAlerta[0] || "Sem risco crítico dominante."));
  var cardFoco = cardsResumo.filter(function(c){ return c.statusEstr === "foco_mes" || c.statusEstr === "prioritario" || c.statusEstr === "concentrar_gastos"; })[0] || cardsResumo.slice().sort(function(a,b){ return b.usoRealPct - a.usoRealPct; })[0] || null;
  return {
    bancoFoco:bancoFoco,
    planoFoco:plano,
    criticos:criticos,
    acaoPrincipal:plano.actions[0] || "Manter disciplina do mês.",
    riscoPrincipal:risco,
    cardFoco:cardFoco,
    metaMes:fluxo.sobraPrevista >= 0 ? "Preservar sobra positiva e limite saudável." : "Reequilibrar caixa antes de novas solicitações.",
    resumoExecutivo:"Score interno orientativo do app, nao score oficial de banco. O foco do mês aponta a frente com maior ganho marginal esperado."
  };
}
function getChecklistGeral(fluxo, cardsResumo, als) {
  return [
    boolItem("Receitas organizadas", fluxo.receita > 0, f$(fluxo.receita)),
    boolItem("Sobra prevista calculada", true, f$(fluxo.sobraPrevista)),
    boolItem("Sobra realizada acompanhada", true, f$(fluxo.sobraRealizada)),
    boolItem("Faturas sob controle", cardsResumo.every(function(c){ return !c.faturas[0] || c.faturas[0].paga || c.faturas[0].vencDate >= getRefDatePeriodo(c.faturas[0].mes, c.faturas[0].ano); }), "Sem vencidas no periodo"),
    boolItem("PIX sob controle", fluxo.pix >= 0, f$(fluxo.pix)),
    boolItem("Limite saudável", cardsResumo.every(function(c){ return c.usoRealPct <= 50; }), cardsResumo.length ? pctSafe(cardsResumo.reduce(function(s,c){ return s + c.usoRealPct; },0)/cardsResumo.length) : "0.0%"),
    boolItem("Caixa com cobertura", fluxo.sobraPrevista >= 0, f$(fluxo.sobraPrevista)),
    boolItem("Nenhum atraso", !(als||[]).some(function(a){ return a.t === "Fatura" && a.s === "danger"; }), "Monitorado pelos alertas"),
    boolItem("Nenhum rotativo", cardsResumo.every(function(c){ return !c.faturas[0] || c.faturas[0].paga || c.faturas[0].total === 0; }), "Heuristica interna do app"),
    boolItem("Nenhum erro crítico ignorado", !(als||[]).some(function(a){ return a.s === "danger"; }), (als||[]).filter(function(a){ return a.s === "danger"; }).length + " críticos")
  ];
}
function getWeeklyChecklist() {
  return [
    {id:"wk_saldo", titulo:"Revisar saldo e almofada", desc:"Especialmente no banco foco do mês"},
    {id:"wk_limite", titulo:"Revisar uso do limite", desc:"Manter abaixo de 30% no ciclo"},
    {id:"wk_fecha", titulo:"Revisar compras perto do fechamento", desc:"Evitar pressao perto do ciclo"},
    {id:"wk_compromissos", titulo:"Revisar compromissos da semana", desc:"PIX, faturas e aportes"},
    {id:"wk_alertas", titulo:"Revisar alertas", desc:"Sem deixar pendências críticas acumularem"},
    {id:"wk_cartao", titulo:"Revisar cartão foco", desc:"Uso e status do cartão prioritário"},
    {id:"wk_janela", titulo:"Revisar janela de pedido ou upgrade", desc:"Usar timing planejado"},
    {id:"wk_sobra", titulo:"Revisar risco para a sobra do mês", desc:"Garantir sobra positiva"}
  ];
}
function getWeekKey() {
  var now = new Date();
  var day = now.getDay();
  var mon = new Date(now);
  mon.setDate(mon.getDate() - (day === 0 ? 6 : day - 1));
  return "wk" + String(mon.getMonth()+1).padStart(2,"0") + String(mon.getDate()).padStart(2,"0");
}


function getStorageSafe() {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch (e) {}
  return null;
}

function doSave(d) {
  try {
    var j = JSON.stringify(d);
    var s = getStorageSafe();
    if (s) s.setItem(SK, j);
    return true;
  } catch (e) {
    return false;
  }
}

function doLoad() {
  try {
    var s = getStorageSafe();
    var l = s ? s.getItem(SK) : null;
    if (l) return JSON.parse(l);
  } catch (e) {}
  return null;
}

function saveBackup(data) {
  try {
    var s = getStorageSafe();
    if (!s) return;
    var slots = [SK+"_bk1", SK+"_bk2", SK+"_bk3"];
    var oldest = slots[0];
    var oldestTime = Infinity;
    for (var i = 0; i < slots.length; i++) {
      var raw = s.getItem(slots[i]);
      if (!raw) { oldest = slots[i]; break; }
      try { var d = JSON.parse(raw); if ((d._bkTime||0) < oldestTime) { oldestTime = d._bkTime||0; oldest = slots[i]; } } catch(e) { oldest = slots[i]; break; }
    }
    s.setItem(oldest, JSON.stringify(Object.assign({}, data, {_bkTime: Date.now(), _bkDate: new Date().toISOString().slice(0,10)})));
  } catch(e) {}
}

function listBackups() {
  return new Promise(function(resolve) {
    var slots = [];
    try {
      var s = getStorageSafe();
      if (!s) { resolve([]); return; }
      var keys = [SK+"_bk1", SK+"_bk2", SK+"_bk3"];
      for (var i = 0; i < keys.length; i++) {
        var raw = s.getItem(keys[i]);
        if (raw) {
          try { var d = JSON.parse(raw); slots.push({slot: keys[i], date: d._bkDate || "?", time: d._bkTime || 0, data: d}); } catch(e) {}
        }
      }
      slots.sort(function(a,b) { return b.time - a.time; });
    } catch(e) {}
    resolve(slots);
  });
}

function norm(r) {
  if (!r || typeof r !== "object") return null;
  if (r.lancamentos && !Array.isArray(r.lancamentos)) return null;
  if (r.cartoes && !Array.isArray(r.cartoes)) return null;
  if (r.dividas && !Array.isArray(r.dividas)) return null;
  if (r.investimentos && !Array.isArray(r.investimentos)) return null;
  if (r.metas && !Array.isArray(r.metas)) return null;
  var d = Object.assign({}, DEF, r);
  var oldVer = r.v || 0;
  d.v = VER;
  
  // Migration v12→v13: force update card definitions
  if (oldVer < 13) {
    d.cartoes = DEF.cartoes;
    d.contas = DEF.contas;
    d.dividas = DEF.dividas;
    d.investimentos = DEF.investimentos;
    d.investimentoFixo = DEF.investimentoFixo;
  }

  var savedCats = r.categorias || [];
  d.categorias = CATS.map(function(cat) {
    var saved = null;
    for (let sc = 0; sc < savedCats.length; sc++) {
      if (savedCats[sc].id === cat.id) { saved = savedCats[sc]; break; }
    }
    return Object.assign({}, cat, { orc: saved ? (saved.orc || 0) : (cat.orc || 0), emoji: (saved && saved.emoji) || cat.emoji || "📦", cor: (saved && saved.cor) || cat.cor || "#6B7280" });
  });
  if (!Array.isArray(d.lancamentos)) d.lancamentos = DEF.lancamentos;
  d.lancamentos = d.lancamentos.map(function(l) {
    if (!l.mes) { var x = gMA(l.data); l.mes = x.mes; l.ano = x.ano; }
    var out = {id:l.id||uid(), data:l.data||hj(), mes:l.mes, ano:l.ano, tipo:l.tipo||"despesa", cat:l.cat||l.categoria||"c8", desc:l.desc||l.descricao||"", valor:l.valor||0, totalCompra:l.totalCompra||0, status:l.status||"pago", cartaoId:l.cartaoId||"", pg:l.pg||(l.cartaoId?"cartao":"pix"), rec:!!l.rec, pT:l.pT||l.parcTotal||0, pA:l.pA||l.parcAtual||0};
    var descL = (out.desc||"").toLowerCase();
    var pixForce = ["acordo serasa","empr. barbara","unip"];
    var isPix = false;
    for (let pf = 0; pf < pixForce.length; pf++) { if (descL.indexOf(pixForce[pf]) >= 0) { isPix = true; break; } }
    if (isPix) { out.pg = "pix"; out.cartaoId = ""; }
    else if ((out.tipo === "parcela" || out.cat === "c14") && !out.cartaoId) { out.pg = "cartao"; out.cartaoId = "cd1"; }
    var brbFixas = ["anuidade brb","faculdade barbara","faculdade bárbara","claude","spotify","icloud","chatgpt","tec concursos","legis","medicamentos","ritalina","venvanse","cinemark","streaming","totalpass barbara","totalpass","total pass","spike","clube curtai","curtai","supermercado","cafe capsulas","café cápsulas","gastos saidas","gastos saídas","gasolina","barbeiro","lavagem carro","pós-graduação","pos graduacao","estratégia concursos","estrategia concursos","boticário","boticario","dock robô","dock robo","aspirador robô","aspirador robo","revpoints"];
    if (!isPix && (!out.cartaoId || out.pg !== "cartao")) {
      for (let bf = 0; bf < brbFixas.length; bf++) {
        if (descL.indexOf(brbFixas[bf]) >= 0) { out.pg = "cartao"; out.cartaoId = "cd1"; break; }
      }
    }
    if (descL.indexOf("anuidade brb") >= 0) out.rec = false;
    return out;
  });
  d.lancamentos = d.lancamentos.filter(function(l){return (l.desc||"").indexOf("Empr. Bradesco") < 0});
  d.lancamentos.forEach(function(l){
    if (l.desc === "Claude" && l.rec) l.valor = 689;
    if (l.desc === "Santander Select" && l.rec) l.valor = 50;
  });
  // Inject new recurrent subscriptions if missing
  var novasRec = [
    {desc:"Serasa Premium",valor:23.90,cat:"c3",pg:"pix",cartaoId:""},
    {desc:"Revpoints 500",valor:46.90,cat:"c16",pg:"cartao",cartaoId:"cd1"}
  ];
  novasRec.forEach(function(nr){
    var nrL = nr.desc.toLowerCase();
    var existe = d.lancamentos.some(function(l){return l.desc.toLowerCase()===nrL});
    if (!existe) {
      d.lancamentos.push({id:uid(),data:"2026-04-01",mes:4,ano:2026,tipo:"despesa",cat:nr.cat,desc:nr.desc,valor:nr.valor,status:"pendente",cartaoId:nr.cartaoId,pg:nr.pg,rec:true,pT:0,pA:0,totalCompra:0});
    }
  });
  var novasParc = [
    {desc:"Rack",valor:81.77,pT:12,data:"2026-05-01"},
    {desc:"SSD PS5",valor:97.91,pT:12,data:"2026-05-01"},
    {desc:"Cafeteira",valor:444.00,pT:12,data:"2026-05-01"},
    {desc:"Pneu",valor:73.00,pT:12,data:"2026-05-01"},
    {desc:"Mecânico",valor:450.00,pT:6,data:"2026-06-01"},
  ];
  novasParc.forEach(function(np){
    var npL = np.desc.toLowerCase();
    var existe = d.lancamentos.some(function(l){return l.desc.toLowerCase()===npL && l.tipo==="parcela"});
    if (!existe) {
      var ma = gMA(np.data);
      d.lancamentos.push({id:uid(),data:np.data,mes:ma.mes,ano:ma.ano,tipo:"parcela",cat:"c8",desc:np.desc,valor:np.valor,status:"pendente",cartaoId:np.cartaoId||"cd1",pg:"cartao",rec:false,pT:np.pT,pA:1,totalCompra:0});
    }
  });
  if (!Array.isArray(d.contas) || !d.contas.length) d.contas = DEF.contas;
  if (!Array.isArray(d.cartoes)) d.cartoes = DEF.cartoes;
  d.cartoes = d.cartoes.map(function(c){ return Object.assign({obs:"", bankKey: inferBankKey(c.nome), logoUrl:"", emoji:"", cor2:"", visual:"black", statusEstr:"manter_estável", titular:"joao"}, c, { bankKey:(c.bankKey||inferBankKey(c.nome||c.band)), logoUrl:c.logoUrl||"", emoji:c.emoji||"", cor2:c.cor2||"", visual:c.visual||"black", statusEstr:c.statusEstr||"manter_estável", titular:c.titular||"joao" }); });
  if (!d.ratingMensal || typeof d.ratingMensal !== "object") d.ratingMensal = {};
  if (!d.salarioDia) d.salarioDia = 25;
  if (!d.faturasManuais || typeof d.faturasManuais !== "object") d.faturasManuais = {};
  var defFat = DEF.faturasManuais || {};
  Object.keys(defFat).forEach(function(k) {
    if (!d.faturasManuais[k]) d.faturasManuais[k] = defFat[k];
  });
  return d;
}


const bx = {background:"linear-gradient(135deg, rgba(10,14,28,0.32), rgba(14,18,36,0.18))", borderRadius:18, padding:22, border:"1px solid rgba(0,245,212,0.16)", backdropFilter:"blur(40px) saturate(1.9)", WebkitBackdropFilter:"blur(40px) saturate(1.9)", boxShadow:"0 24px 60px -24px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(0,245,212,0.06), inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -1px 0 rgba(0,0,0,0.18)", position:"relative", overflow:"hidden", transition:"transform 0.3s cubic-bezier(0.2,0.8,0.2,1), border-color 0.3s, box-shadow 0.3s, backdrop-filter 0.3s"};
const inp = {width:"100%", background:"rgba(0,245,212,0.025)", border:"0.5px solid rgba(0,245,212,0.20)", borderRadius:12, padding:"10px 14px", color:T.text, fontSize:12, outline:"none", fontFamily:FF.mono, letterSpacing:"0.02em", boxSizing:"border-box", transition:"border-color 0.2s, box-shadow 0.2s, background 0.2s, backdrop-filter 0.2s", boxShadow:"inset 0 1px 2px rgba(0,0,0,0.18)", backdropFilter:"blur(14px) saturate(1.4)", WebkitBackdropFilter:"blur(14px) saturate(1.4)"};
const mc = {padding:"10px 12px",borderRadius:10,background:"linear-gradient(135deg, rgba(0,245,212,0.04), rgba(123,76,255,0.02))",border:"0.5px solid rgba(0,245,212,0.20)",borderTop:"1px solid rgba(0,245,212,0.36)",backdropFilter:"blur(20px) saturate(1.6)",WebkitBackdropFilter:"blur(20px) saturate(1.6)",boxShadow:"inset 0 1px 0 rgba(0,245,212,0.08), 0 2px 8px rgba(0,0,0,0.15), 0 0 0 0.5px rgba(0,245,212,0.05)",position:"relative",overflow:"hidden"};
const mc2 = {padding:"8px 10px",borderRadius:8,background:"rgba(0,245,212,0.02)",border:"0.5px solid rgba(0,245,212,0.12)",backdropFilter:"blur(16px) saturate(1.4)",WebkitBackdropFilter:"blur(16px) saturate(1.4)"};
const lb = {fontFamily:FF.mono, fontSize:10, color:"#5B6A85", textTransform:"uppercase", letterSpacing:"1.5px", fontWeight:500};



function Skeleton(props) {
  var w = props.w || "100%";
  var h = props.h || 16;
  return <div style={{width:w, height:h, borderRadius:8, background:"rgba(255,255,255,0.06)", animation:"pulse 1.5s infinite"}} />;
}
function SkeletonCard() {
  return <div style={{padding:16,borderRadius:16,background:"rgba(8,8,22,0.82)",border:"1px solid rgba(0,229,255,0.08)"}}>
    <Skeleton h={12} w="40%" /><div style={{height:8}} /><Skeleton h={24} w="60%" /><div style={{height:8}} /><Skeleton h={8} w="80%" />
  </div>;
}

function EV(props) {
  var _s = useState(false); var ed = _s[0]; var setEd = _s[1];
  var _t = useState(""); var t = _t[0]; var setT = _t[1];
  var r = useRef(null);
  useEffect(function() { if (ed && r.current) r.current.focus(); }, [ed]);
  if (ed) return (
    <div style={{display:"flex",gap:5,alignItems:"center"}}>
      <input ref={r} value={t} onChange={function(e){setT(e.target.value)}} onKeyDown={function(e){if(e.key==="Enter"){props.onChange(parseBR(t));setEd(false)}if(e.key==="Escape")setEd(false)}} style={Object.assign({},inp,{fontSize:props.large?18:13,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"})} />
      <button onClick={function(){props.onChange(parseBR(t));setEd(false)}} style={{background:T.green,border:"none",borderRadius:7,padding:"4px 6px",cursor:"pointer",display:"flex"}}><Check size={12} color="#fff" /></button>
    </div>
  );
  return (
    <div onClick={function(){setT(String(props.value));setEd(true)}} style={{cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
      <span style={{fontSize:props.large?21:15,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(props.value)}</span>
      <Edit3 size={10} color={T.dim} style={{opacity:0.4}} />
    </div>
  );
}

function PB(props) {
  var p = Math.min(Math.max((props.value/(props.max||1))*100,0),100);
  var h = props.h || 5;
  var c = props.color||T.green;
  return <div style={{width:"100%",height:h,borderRadius:h,background:"rgba(255,255,255,0.05)",overflow:"hidden",position:"relative",boxShadow:"inset 0 1px 2px rgba(0,0,0,0.4)"}}><div style={{width:p+"%",height:"100%",borderRadius:h,background:"linear-gradient(90deg, "+c+", "+c+"DD)",transition:"width 0.8s cubic-bezier(0.4,0,0.2,1)",position:"relative",boxShadow:"0 0 8px "+c+"60, 0 0 2px "+c}}><div style={{position:"absolute",inset:0,borderRadius:h,background:"linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)",animation:"dataFlow 3s linear infinite",pointerEvents:"none"}} /></div></div>;
}

function ScoreGauge(props) {
  var score = props.value || 0;
  var max = props.max || 100;
  var pct = Math.min(score/max, 1);
  var r = 40;
  var circ = 2 * Math.PI * r;
  var offset = circ * (1 - pct * 0.75);
  var color = props.color || T.green;
  return <div style={{position:"relative",width:110,height:110}}>
    <svg viewBox="0 0 100 100" style={{transform:"rotate(135deg)",width:110,height:110}}>
      <defs>
        <linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor={T.cyan} /><stop offset="50%" stopColor={T.green} /><stop offset="100%" stopColor={T.purple} /></linearGradient>
      </defs>
      {[0,1,2,3,4,5,6,7].map(function(tick){var ang = (135 + (tick/8)*270) * Math.PI/180; var x1 = 50 + Math.cos(ang)*46; var y1 = 50 + Math.sin(ang)*46; var x2 = 50 + Math.cos(ang)*49; var y2 = 50 + Math.sin(ang)*49; return <line key={tick} x1={x1} y1={y1} x2={x2} y2={y2} stroke={T.cyan+"30"} strokeWidth="0.5" />;})}
      <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(0,229,255,0.06)" strokeWidth="5" strokeDasharray={circ*0.75 + " " + circ*0.25} strokeLinecap="round" />
      <circle cx="50" cy="50" r={r} fill="none" stroke="url(#gaugeGrad)" strokeWidth="5" strokeDasharray={circ*0.75 + " " + circ*0.25} strokeDashoffset={offset} strokeLinecap="round" style={{filter:"drop-shadow(0 0 10px "+color+"90)",transition:"stroke-dashoffset 1.2s cubic-bezier(0.22,1,0.36,1)"}} />
      <circle cx="50" cy="50" r={r-5} fill="none" stroke={color+"12"} strokeWidth="0.5" />
    </svg>
    <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
      <div className="mono-num" style={{fontSize:28,fontWeight:800,letterSpacing:-1,color:T.cyan,textShadow:"0 0 14px "+T.cyan+"70, 0 0 30px "+T.cyan+"30"}}>{score}</div>
      <div style={{fontSize:11,color:T.dim,fontWeight:600,textTransform:"uppercase",letterSpacing:2,fontFamily:"'Geist Mono', monospace"}}>/ {max}</div>
    </div>
    <div style={{position:"absolute",inset:0,borderRadius:"50%",animation:"pulseRing 3s ease-in-out infinite",pointerEvents:"none",boxShadow:"0 0 20px "+color+"20, inset 0 0 20px "+color+"08"}} />
  </div>;
}

function TechFrame(props) {
  var c = props.color || T.cyan;
  return <div style={Object.assign({position:"relative"}, props.style || {})}>
    <span style={{position:"absolute",top:0,left:0,width:10,height:10,borderTop:"1px solid "+c+"60",borderLeft:"1px solid "+c+"60",pointerEvents:"none",zIndex:2}} />
    <span style={{position:"absolute",top:0,right:0,width:10,height:10,borderTop:"1px solid "+c+"60",borderRight:"1px solid "+c+"60",pointerEvents:"none",zIndex:2}} />
    <span style={{position:"absolute",bottom:0,left:0,width:10,height:10,borderBottom:"1px solid "+c+"60",borderLeft:"1px solid "+c+"60",pointerEvents:"none",zIndex:2}} />
    <span style={{position:"absolute",bottom:0,right:0,width:10,height:10,borderBottom:"1px solid "+c+"60",borderRight:"1px solid "+c+"60",pointerEvents:"none",zIndex:2}} />
    {props.children}
  </div>;
}

function Tip(props) {
  if (!props.active || !props.payload || !props.payload.length) return null;
  return (
    <div style={{background:"linear-gradient(135deg, rgba(14,18,36,0.92), rgba(10,14,28,0.82))",border:"1px solid rgba(255,255,255,0.10)",borderRadius:14,padding:"12px 16px",boxShadow:"0 0 0 0.5px rgba(0,245,212,0.15), 0 0 40px -10px "+T.cyan+", 0 20px 40px rgba(0,0,0,0.55)",backdropFilter:"blur(28px) saturate(1.8)",WebkitBackdropFilter:"blur(28px) saturate(1.8)",position:"relative",overflow:"hidden",minWidth:140}}>
      <div style={{position:"absolute",top:0,left:"15%",right:"15%",height:1,background:"linear-gradient(90deg, transparent, "+T.cyan+"99, transparent)",pointerEvents:"none"}} />
      <div style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.cyan,marginBottom:8,letterSpacing:"0.22em",textTransform:"uppercase",position:"relative",zIndex:1,fontWeight:500}}>{props.label}</div>
      {props.payload.map(function(p,i) {
        return <div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,marginBottom:4,position:"relative",zIndex:1,fontFamily:"'Space Grotesk',sans-serif"}}>
          <div style={{width:7,height:7,borderRadius:"50%",background:p.color,boxShadow:"0 0 10px "+p.color+"AA"}} />
          <span style={{color:T.muted,flex:1}}>{p.name}</span>
          <span className="mono-num" style={{fontWeight:500,color:p.color}}>{f$(p.value)}</span>
        </div>;
      })}
    </div>
  );
}

function Bd(props) {
  var c = props.color || T.dim;
  return <span style={{padding:"3px 9px",borderRadius:999,background:"linear-gradient(135deg, "+c+"20, "+c+"08)",color:c,fontSize:11,fontWeight:700,textTransform:"uppercase",border:"0.5px solid "+c+"35",letterSpacing:0.8,boxShadow:"0 0 10px "+c+"18, inset 0 1px 0 rgba(255,255,255,0.05)",fontFamily:"'Geist Mono', monospace"}}>{props.children}</span>;
}

function FL(props) {
  return <div style={{marginBottom:10}}><div style={{fontSize:12,color:T.muted,marginBottom:3,fontWeight:600}}>{props.label}</div>{props.children}</div>;
}

function IBtn(props) {
  var I = props.icon;
  var c = props.color || T.dim;
  return <button onClick={props.onClick} style={{background:"linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))",border:"0.5px solid "+c+"25",cursor:"pointer",padding:7,display:"flex",borderRadius:10,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.04), 0 2px 4px rgba(0,0,0,0.2)",transition:"all 0.2s cubic-bezier(0.22,1,0.36,1)"}}><I size={12} color={c} style={{filter:"drop-shadow(0 0 2px "+c+"40)"}} /></button>;
}


function LForm(props) {
  var _s = useState(props.lanc || {id:"",data:hj(),tipo:"despesa",cat:"c8",desc:"",valor:"",totalCompra:"",status:"pendente",cartaoId:"",pg:"pix",rec:false,pT:0,pA:1});
  var f = _s[0]; var setF = _s[1];
  var _err = useState({}); var errs = _err[0]; var setErrs = _err[1];
  var catTimer = useRef(null);
  function u(k,v) { setF(function(prev) { var n = {...prev}; n[k]=v; return n; }); setErrs(function(prev){ var n = {...prev}; delete n[k]; return n; }); }
  var fc = props.cats.filter(function(c) { return f.tipo === "receita" ? c.tipo === "receita" : c.tipo === "despesa"; });
  var numP = parseInt(f.pT) || 0;
  var numA = parseInt(f.pA) || 1;
  var errStyle = function(k) { return errs[k] ? {borderColor:T.red, boxShadow:"0 0 0 2px "+T.red+"25"} : {}; };
  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <FL label="Data"><input type="date" value={f.data} onChange={function(e){u("data",e.target.value)}} style={Object.assign({},inp,errStyle("data"))} /></FL>
        <FL label="Tipo"><select value={f.tipo} onChange={function(e){var v=e.target.value;u("tipo",v); if(v==="receita"){u("pg","pix");u("cartaoId","");}}} style={inp}><option value="receita">Receita</option><option value="despesa">Despesa</option><option value="parcela">Parcela</option></select></FL>
      </div>
      <FL label="Descricao">{errs.desc && <span style={{color:T.red,fontSize:11,fontWeight:700,marginLeft:6}}>Obrigatorio</span>}<input value={f.desc} onChange={function(e){u("desc",e.target.value); if(props.onSuggestCat){clearTimeout(catTimer.current);catTimer.current=setTimeout(function(){props.onSuggestCat(e.target.value)},600)}}} placeholder="Ex: Supermercado" style={Object.assign({},inp,errStyle("desc"))} /></FL>
      {props.aiCatSug && (function(){var found=fc.find(function(c){return c.id===props.aiCatSug});return found ? <div onClick={function(){u("cat",found.id)}} style={{padding:"5px 10px",borderRadius:8,background:T.cyan+"10",border:"1px solid "+T.cyan+"20",fontSize:11,color:T.cyan,cursor:"pointer",marginBottom:8,display:"flex",alignItems:"center",gap:4}}><Activity size={10} /> IA sugere: <strong>{found.nome}</strong> <span style={{color:T.dim}}>(clique para aplicar)</span></div> : null})()}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <FL label="Valor (R$)">{errs.valor && <span style={{color:T.red,fontSize:11,fontWeight:700,marginLeft:6}}>Obrigatorio</span>}<input value={f.valor} onChange={function(e){u("valor",e.target.value)}} placeholder="0,00" style={Object.assign({},inp,errStyle("valor"))} /></FL>
        <FL label="Categoria"><select value={f.cat} onChange={function(e){u("cat",e.target.value)}} style={inp}>{fc.map(function(c){return <option key={c.id} value={c.id}>{c.nome}</option>})}</select></FL>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <FL label="Status"><select value={f.status} onChange={function(e){u("status",e.target.value)}} style={inp}><option value="pago">Pago</option><option value="pendente">Pendente</option></select></FL>
        <FL label="Parcelas (0=avulso)"><input type="number" value={f.pT} onChange={function(e){u("pT",e.target.value)}} style={inp} /></FL>
      </div>
      {f.tipo !== "receita" && <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <FL label="Forma de pagamento"><select value={f.pg||"pix"} onChange={function(e){u("pg",e.target.value); if(e.target.value!=="cartao"){u("cartaoId","");u("totalCompra","");}}} style={inp}><option value="pix">PIX</option><option value="cartao">Cartão de crédito</option></select></FL>
        <FL label="Cartao">{errs.cartaoId && <span style={{color:T.red,fontSize:11,fontWeight:700,marginLeft:6}}>Selecione</span>}{(f.pg||"pix") === "cartao" ? <select value={f.cartaoId||""} onChange={function(e){u("cartaoId",e.target.value)}} style={Object.assign({},inp,errStyle("cartaoId"))}><option value="">Selecione</option>{props.cards.map(function(c){return <option key={c.id} value={c.id}>{c.nome}</option>})}</select> : <div style={{padding:"8px 10px",borderRadius:8,background:T.card,border:"1px solid "+T.border,fontSize:12,color:T.dim}}>Nao se aplica ao PIX</div>}</FL>
      </div>}
      {f.tipo !== "receita" && (f.pg||"pix") === "cartao" && numP > 1 && <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <FL label="Valor total da compra"><input value={f.totalCompra||""} onChange={function(e){u("totalCompra",e.target.value)}} placeholder="Opcional" style={inp} /></FL>
        <FL label="Valor por parcela">{parseBR(f.totalCompra)>0 ? <div style={{padding:"8px 10px",borderRadius:8,background:T.card,border:"1px solid "+T.border,fontSize:12,color:T.text,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(parseBR(f.totalCompra)/Math.max(1,numP))}</div> : <div style={{padding:"8px 10px",borderRadius:8,background:T.card,border:"1px solid "+T.border,fontSize:12,color:T.dim}}>Use o campo acima para dividir automaticamente.</div>}</FL>
      </div>}
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}>
        <input type="checkbox" checked={f.rec} onChange={function(e){u("rec",e.target.checked)}} />
        <span style={{fontSize:12,color:T.muted}}>Recorrente (repete todo mes)</span>
      </div>
      {numP > 1 && !(props.lanc && props.lanc.id) && <div style={{padding:"8px 12px",borderRadius:8,background:T.blue+"10",border:"1px solid "+T.blue+"20",fontSize:12,color:T.blue,marginBottom:10}}>{numP-numA} parcelas futuras serao criadas.</div>}
      <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
        <button onClick={props.onClose} style={{padding:"7px 14px",borderRadius:8,background:T.card,border:"1px solid "+T.border,color:T.muted,cursor:"pointer",fontSize:12}}>Cancelar</button>
        <button onClick={function(){
          var e = {};
          if(!f.desc.trim()) e.desc = true;
          if(!parseBR(f.valor)) e.valor = true;
          if(f.tipo!=="receita" && (f.pg||"pix")==="cartao" && !f.cartaoId) e.cartaoId = true;
          if(Object.keys(e).length > 0) { setErrs(e); return; }
          var r=gMA(f.data);
          var valorBase = parseBR(f.valor);
          if (f.tipo !== "receita" && (f.pg||"pix") === "cartao" && numP > 1 && parseBR(f.totalCompra) > 0) valorBase = parseBR(f.totalCompra) / Math.max(1, numP);
          props.onSave(Object.assign({},f,{id:f.id||uid(),mes:r.mes,ano:r.ano,valor:valorBase,totalCompra:parseBR(f.totalCompra)||0,pg:f.tipo==="receita"?"pix":(f.pg||"pix"),cartaoId:f.tipo==="receita"||((f.pg||"pix")!=="cartao")?"":(f.cartaoId||""),pT:numP,pA:numA}),numP);
          props.onClose();
        }} style={{padding:"7px 14px",borderRadius:8,background:T.green,border:"none",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:600}}>Salvar</button>
      </div>
    </div>
  );
}

function SForm(props) {
  var _s = useState(props.data || {}); var f = _s[0]; var setF = _s[1];
  function u(k,v) { setF(function(prev) { var n = {...prev}; n[k]=v; return n; }); }
  return (
    <div>
      {props.fields.map(function(fd) {
        return <FL key={fd.key} label={fd.label}>{fd.type==="select" ? <select value={f[fd.key]||""} onChange={function(e){u(fd.key,e.target.value)}} style={inp}>{fd.opts.map(function(o){return <option key={o.v} value={o.v}>{o.l}</option>})}</select> : <input type={fd.type||"text"} value={f[fd.key]||""} onChange={function(e){u(fd.key,e.target.value)}} style={inp} />}</FL>;
      })}
      <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:8}}>
        <button onClick={props.onClose} style={{padding:"7px 14px",borderRadius:8,background:T.card,border:"1px solid "+T.border,color:T.muted,cursor:"pointer",fontSize:12}}>Cancelar</button>
        <button onClick={function(){props.onSave(Object.assign({},f,{id:f.id||uid()}));props.onClose()}} style={{padding:"7px 14px",borderRadius:8,background:T.green,border:"none",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:600}}>Salvar</button>
      </div>
    </div>
  );
}

const TABS = [
  {id:"visao",lb:"Geral",ic:BarChart3},
  {id:"anual",lb:"Ano",ic:Calendar},
  {id:"cal",lb:"Calend.",ic:Calendar},
  {id:"lanc",lb:"Lanc.",ic:Filter},
  {id:"cards",lb:"Cards",ic:CreditCard},
  {id:"rating",lb:"Coaching",ic:Shield},
  {id:"orc",lb:"Orc.",ic:DollarSign},
  {id:"assin",lb:"Assin.",ic:Repeat},
  {id:"parc",lb:"Parcelas",ic:Landmark},
  {id:"metas",lb:"Metas",ic:Target},
  {id:"invest",lb:"Invest.",ic:TrendingUp},
  {id:"alertas",lb:"Alertas",ic:Bell},
  {id:"ia",lb:"IA",ic:Activity}
];

// =====================================================
// VV (Vault Vivo) — Helpers visuais v17
// =====================================================

function NumberTicker(props) {
  var target = Number(props.value) || 0;
  var prefix = props.prefix || "";
  var suffix = props.suffix || "";
  var decimals = typeof props.decimals === "number" ? props.decimals : 0;
  var duration = props.duration || 700;
  var format = props.format || function(n){ return n.toLocaleString("pt-BR", {minimumFractionDigits:decimals, maximumFractionDigits:decimals}); };
  var _val = useState(0); var val = _val[0]; var setVal = _val[1];
  var prev = useRef(0);
  var _flash = useState(""); var flash = _flash[0]; var setFlash = _flash[1];
  useEffect(function(){
    var start = performance.now();
    var from = prev.current;
    var diff = target - from;
    var raf;
    function tick(t){
      var p = Math.min((t - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      setVal(from + diff * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else {
        prev.current = target;
        if (Math.abs(diff) > 0.01) {
          setFlash(diff > 0 ? "vv-num-flash" : "vv-num-bleed");
          setTimeout(function(){ setFlash(""); }, 700);
        }
      }
    }
    raf = requestAnimationFrame(tick);
    return function(){ if (raf) cancelAnimationFrame(raf); };
  }, [target]);
  return <span className={flash} style={Object.assign({display:"inline-block"}, props.style||{})}>{prefix}{format(val)}{suffix}</span>;
}

function VVSparkline(props) {
  var data = props.data || [];
  var color = props.color || "#00F5D4";
  var w = props.width || 220;
  var h = props.height || 40;
  var live = props.live !== false;
  if (data.length < 2) return null;
  var min = Math.min.apply(null, data);
  var max = Math.max.apply(null, data);
  var range = (max - min) || 1;
  var step = w / (data.length - 1);
  var pts = data.map(function(v, i){
    var x = i * step;
    var y = h - 4 - ((v - min) / range) * (h - 8);
    return {x:x, y:y};
  });
  var line = pts.map(function(p, i){ return (i===0?"M":"L") + p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ");
  var area = line + " L" + w + "," + h + " L0," + h + " Z";
  var last = pts[pts.length - 1];
  var gradId = "vvspk-" + (props.id || Math.random().toString(36).slice(2,8));
  return (
    <svg viewBox={"0 0 " + w + " " + h} preserveAspectRatio="none" style={{width:"100%", height:h, display:"block"}}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.45"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={area} fill={"url(#" + gradId + ")"}/>
      <path d={line} stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      {live && <circle className="vv-spark-pt" cx={last.x} cy={last.y} r="3" fill={color}/>}
    </svg>
  );
}

function PulseBadge(props) {
  var color = props.color || "#A8FF3E";
  return (
    <span style={Object.assign({display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 8px", borderRadius:999, background:color+"1A", color:color, border:"0.5px solid "+color+"55", lineHeight:1}, props.style||{})}>
      <span className="vv-pulse-dot" style={{color:color, width:5, height:5}}/>
      {props.children}
    </span>
  );
}

function ShimmerBox(props) {
  return <div className="vv-shimmer" style={Object.assign({width:"100%", height:props.height||40}, props.style||{})}/>;
}

function HoloBorder(props) {
  return (
    <div style={Object.assign({position:"relative"}, props.style||{})}>
      <span className="vv-holo"/>
      <div style={{position:"relative", zIndex:1}}>{props.children}</div>
    </div>
  );
}

function TopLine(props) {
  return <span className="vv-topline" style={props.style||{}}/>;
}

function SignalBars(props) {
  return (
    <span className="vv-signal" style={Object.assign({color:props.color||"#00F5D4"}, props.style||{})}>
      <span/><span/><span/><span/>
    </span>
  );
}

function MiniGauge(props) {
  var v = Math.max(0, Math.min(1, Number(props.value)||0));
  var color = props.color || "#00F5D4";
  var size = props.size || 60;
  var stroke = props.stroke || 6;
  var r = (size - stroke) / 2;
  var c = 2 * Math.PI * r;
  var off = c * (1 - v);
  return (
    <svg width={size} height={size} viewBox={"0 0 "+size+" "+size} style={{display:"block"}}>
      <circle cx={size/2} cy={size/2} r={r} stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} fill="none"/>
      <circle cx={size/2} cy={size/2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off} transform={"rotate(-90 "+size/2+" "+size/2+")"}
        style={{transition:"stroke-dashoffset 1.1s cubic-bezier(0.2,0.8,0.2,1)", filter:"drop-shadow(0 0 6px "+color+"99)"}}/>
      {props.children && <foreignObject x={0} y={0} width={size} height={size}>
        <div style={{width:size, height:size, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'JetBrains Mono', monospace", fontSize:11, color:color, fontWeight:700}}>{props.children}</div>
      </foreignObject>}
    </svg>
  );
}

function MiniHeatmap(props) {
  var data = props.data || []; // array de números
  var color = props.color || "#00F5D4";
  var max = Math.max.apply(null, data.concat([1]));
  var cols = props.cols || 7;
  var size = props.cell || 12;
  var gap = 3;
  return (
    <div style={{display:"grid", gridTemplateColumns:"repeat("+cols+", "+size+"px)", gap:gap}}>
      {data.map(function(v, i){
        var alpha = v <= 0 ? 0.05 : Math.max(0.18, Math.min(1, v / max));
        return <div key={i} title={String(v)} style={{width:size, height:size, borderRadius:3, background:color, opacity:alpha, transition:"opacity 0.4s"}}/>;
      })}
    </div>
  );
}

function fireConfettiBoost(count) {
  if (typeof document === "undefined") return;
  if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var n = count || 60;
  var colors = ["#00F5D4","#A8FF3E","#7B4CFF","#FFB800","#FF00E5","#00C2FF"];
  for (var i = 0; i < n; i++) {
    var c = document.createElement("span");
    c.className = "vv-confetti";
    c.style.background = colors[i % colors.length];
    c.style.left = (40 + Math.random() * 20) + "%";
    c.style.setProperty("--vv-cx", ((Math.random() - 0.5) * 600).toFixed(0) + "px");
    c.style.animationDelay = (Math.random() * 0.2).toFixed(2) + "s";
    c.style.animationDuration = (1.4 + Math.random() * 0.8).toFixed(2) + "s";
    document.body.appendChild(c);
    (function(node){ setTimeout(function(){ if(node.parentNode) node.parentNode.removeChild(node); }, 2400); })(c);
  }
}

function vvSpark(arr, len) {
  // util para gerar série a partir de um array de lançamentos por dia
  var n = len || 14;
  var out = [];
  for (var i = 0; i < n; i++) out.push(arr[i] || 0);
  return out;
}
// =====================================================

function callAI(sys, msg) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({model:"claude-sonnet-4-20250514", max_tokens:1000, system:sys, messages:[{role:"user",content:msg}]})
  }).then(function(r){return r.json()}).then(function(d){
    var txt = "";
    if (d && d.content) { for (let i =0;i<d.content.length;i++) { if (d.content[i].type==="text") txt += d.content[i].text; } }
    return txt || "Sem resposta.";
  })["catch"](function(){return "Erro de conexao."});
}

function callAIChat(sys, msgs) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({model:"claude-sonnet-4-20250514", max_tokens:1000, system:sys, messages:msgs})
  }).then(function(r){return r.json()}).then(function(d){
    var txt = "";
    if (d && d.content) { for (let i =0;i<d.content.length;i++) { if (d.content[i].type==="text") txt += d.content[i].text; } }
    return txt || "Sem resposta.";
  })["catch"](function(){return "Erro de conexao."});
}

// v14: Streaming SSE for progressive text rendering
async function callAIStream(sys, msg, onChunk) {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({model:"claude-sonnet-4-20250514", max_tokens:1000, stream: true, system:sys, messages:[{role:"user",content:msg}]})
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let buffer = "";
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "content_block_delta" && parsed.delta && parsed.delta.text) {
              full += parsed.delta.text;
              if (onChunk) onChunk(full);
            }
          } catch(e) {}
        }
      }
    }
    return full || "Sem resposta.";
  } catch(e) { return "Erro de conexão."; }
}

// v14: MoneyInput component with mask
function MoneyInput({value, onChange, style: customStyle}) {
  var _v = useState(value !== undefined && value !== null ? String(value).replace(".",",") : "");
  var display = _v[0]; var setDisplay = _v[1];
  function handleChange(e) {
    var raw = e.target.value.replace(/[^0-9,]/g, "");
    var parts = raw.split(",");
    if (parts.length > 2) raw = parts[0] + "," + parts.slice(1).join("");
    setDisplay(raw);
    if (onChange) onChange(parseBR(raw));
  }
  function handleBlur() {
    if (display && onChange) {
      var v = parseBR(display);
      setDisplay(v > 0 ? v.toFixed(2).replace(".",",") : "");
    }
  }
  return <input value={display} onChange={handleChange} onBlur={handleBlur} inputMode="decimal" placeholder="0,00" style={Object.assign({},inp,customStyle||{})} />;
}

// === v15: Tooltip custom para Recharts ===
function CustomTooltip(props) {
  if (!props.active || !props.payload || !props.payload.length) return null;
  var label = props.label || "";
  return <div className="custom-tooltip" style={{pointerEvents:"none"}}>
    {label && <div className="label">{label}</div>}
    {props.payload.map(function(p, i){
      var v = typeof p.value === "number" ? p.value.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2}) : p.value;
      return <div key={i} className="value" style={{display:"flex",alignItems:"center",gap:8,marginTop:i>0?4:0}}>
        <span style={{width:8,height:8,borderRadius:2,background:p.color||p.fill||T.cyan,display:"inline-block"}} />
        <span style={{color:T.muted,fontSize:11,fontFamily:"'Geist Mono',monospace"}}>{p.name||""}</span>
        <span style={{marginLeft:"auto",fontWeight:500}}>{typeof p.value === "number" ? "R$ " + v : v}</span>
      </div>;
    })}
  </div>;
}

// === v15: Confetti para signature moments (bater meta) — v17 boosted ===
function fireConfetti() {
  if (typeof document === "undefined") return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var colors = ["#00F5D4","#7B4CFF","#A8FF3E","#FFB800","#00C2FF","#FF00E5"];
  // chuva top-down original
  var count = 48;
  for (var i = 0; i < count; i++) {
    var piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = (Math.random() * 100) + "vw";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDelay = (Math.random() * 0.3) + "s";
    piece.style.animationDuration = (1.8 + Math.random() * 1.2) + "s";
    piece.style.transform = "rotate(" + (Math.random() * 360) + "deg)";
    piece.style.borderRadius = Math.random() > 0.5 ? "2px" : "50%";
    document.body.appendChild(piece);
    setTimeout(function(el){ return function(){ if(el.parentNode) el.parentNode.removeChild(el); }; }(piece), 3200);
  }
  // burst radial central (vv-confetti)
  try { fireConfettiBoost(40); } catch(e){}
  // ring de luz no centro
  try {
    var ring = document.createElement("div");
    ring.style.cssText = "position:fixed;top:50%;left:50%;width:60px;height:60px;border-radius:50%;border:2px solid rgba(0,245,212,0.8);transform:translate(-50%,-50%);pointer-events:none;z-index:9998;animation:ringBurst 1.2s ease-out forwards";
    document.body.appendChild(ring);
    setTimeout(function(){ if(ring.parentNode) ring.parentNode.removeChild(ring); }, 1300);
  } catch(e){}
}

// === v15: Command Palette (⌘K) ===
function CommandPalette(props) {
  var _q = useState(""); var q = _q[0]; var setQ = _q[1];
  var _sel = useState(0); var sel = _sel[0]; var setSel = _sel[1];
  var inputRef = useRef(null);
  useEffect(function(){
    if (props.open && inputRef.current) {
      setQ(""); setSel(0);
      setTimeout(function(){ if(inputRef.current) inputRef.current.focus(); }, 50);
    }
  }, [props.open]);
  var actions = props.actions || [];
  var filtered = actions.filter(function(a){
    if (!q) return true;
    var ql = q.toLowerCase();
    return a.label.toLowerCase().indexOf(ql) >= 0 || (a.cat||"").toLowerCase().indexOf(ql) >= 0;
  });
  function handleKey(e){
    if (e.key === "Escape") { props.onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(sel+1, Math.max(0,filtered.length-1))); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(sel-1, 0)); return; }
    if (e.key === "Enter" && filtered[sel]) { props.onPick(filtered[sel]); props.onClose(); }
  }
  if (!props.open) return null;
  return <div onClick={props.onClose} className="modal-backdrop" style={{display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:"14vh"}}>
    <div onClick={function(e){e.stopPropagation()}} className="modal-panel" style={{width:"min(560px, 92vw)",background:"rgba(10,14,28,0.92)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:14,overflow:"hidden",boxShadow:"0 40px 80px -20px rgba(0,0,0,0.8)"}}>
      <div style={{padding:"14px 16px",borderBottom:"1px solid rgba(255,255,255,0.08)",display:"flex",alignItems:"center",gap:10}}>
        <Search size={16} color={T.muted} />
        <input ref={inputRef} value={q} onChange={function(e){setQ(e.target.value);setSel(0)}} onKeyDown={handleKey} placeholder="Buscar ações, abas, comandos..." style={{flex:1,background:"transparent",border:"none",outline:"none",color:T.text,fontSize:15,fontFamily:"'Space Grotesk',sans-serif"}} />
        <div style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.dim,padding:"3px 8px",borderRadius:4,border:"1px solid rgba(255,255,255,0.08)"}}>ESC</div>
      </div>
      <div style={{maxHeight:360,overflow:"auto"}}>
        {filtered.length === 0 && <div style={{padding:"28px 16px",textAlign:"center",color:T.muted,fontSize:14}}>Nada encontrado para "{q}"</div>}
        {filtered.map(function(a, i){
          return <div key={a.id} onMouseEnter={function(){setSel(i)}} onClick={function(){props.onPick(a);props.onClose()}} style={{padding:"12px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",background:i===sel?"rgba(0,245,212,0.08)":"transparent",borderLeft:i===sel?"2px solid "+T.cyan:"2px solid transparent",transition:"background 0.12s"}}>
            <div style={{display:"flex",flexDirection:"column",gap:2,minWidth:0,flex:1}}>
              <div style={{fontSize:14,color:T.text,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{a.label}</div>
              <div style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.dim,textTransform:"uppercase",letterSpacing:"0.12em"}}>{a.cat||"comando"}</div>
            </div>
            {a.hint && <div style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.muted,padding:"3px 8px",borderRadius:4,border:"1px solid rgba(255,255,255,0.08)",marginLeft:10}}>{a.hint}</div>}
          </div>;
        })}
      </div>
      <div style={{padding:"8px 16px",borderTop:"1px solid rgba(255,255,255,0.08)",display:"flex",justifyContent:"space-between",fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.dim,letterSpacing:"0.1em"}}>
        <span>↑↓ navegar · ↵ selecionar</span>
        <span>⌘K</span>
      </div>
    </div>
  </div>;
}

// === v15: Hero narrativo para dashboard principal ===
function HeroNarrative(props) {
  var pat = props.pat || {};
  var fluxo = props.fluxo || {};
  var metP = props.metP || {};
  var mes = props.mes; var ano = props.ano;
  var privateMode = props.privateMode;
  var narrative = ""; var numHero = 0; var label = ""; var trend = "neutral";
  var pctMeta = 0;
  if (metP && metP.total > 0) {
    pctMeta = Math.min(100, (metP.atual/metP.total)*100);
    var falta = metP.total - metP.atual;
    if (pctMeta >= 100) {
      narrative = "Meta batida. Você conquistou " + f$(metP.total) + ". Hora de traçar o próximo horizonte.";
      trend = "celebration";
    } else if (metP.aporteM > 0) {
      var mesesRestantes = Math.ceil(falta / metP.aporteM);
      narrative = "Faltam " + mesesRestantes + (mesesRestantes===1?" mês":" meses") + " para completar sua meta no ritmo atual de " + f$(metP.aporteM) + "/mês.";
      trend = "progress";
    } else {
      narrative = "Sua meta está em " + pctMeta.toFixed(0) + "%. Faltam " + f$(falta) + " para completar.";
      trend = "progress";
    }
    numHero = metP.atual;
    label = "patrimônio investido · meta " + f$(metP.total);
  } else {
    narrative = fluxo && fluxo.saldoFinal >= 0 ? "Mês no azul. Saldo projetado positivo." : "Atenção ao saldo. Revise gastos variáveis.";
    numHero = fluxo.saldoFinal || 0;
    label = "saldo projetado · " + MSF[mes-1] + " " + ano;
    trend = numHero >= 0 ? "progress" : "warning";
  }
  var col = trend === "celebration" ? T.green : (trend === "warning" ? T.orange : T.cyan);
  var col2 = trend === "celebration" ? T.greenL : (trend === "warning" ? T.gold : T.holo);
  var inteiroParte = String(Math.floor(Math.abs(numHero))).split("").reverse();
  var partsForDisplay = [];
  for (var i = 0; i < inteiroParte.length; i++) {
    if (i > 0 && i % 3 === 0) partsForDisplay.push(".");
    partsForDisplay.push(inteiroParte[i]);
  }
  partsForDisplay.reverse();
  var decPart = (Math.abs(numHero) - Math.floor(Math.abs(numHero))).toFixed(2).slice(2);
  var sinal = numHero < 0 ? "-" : "";
  var statusLabel = trend === "celebration" ? "META_BATIDA" : (trend === "warning" ? "REVISAR_GASTOS" : "EM_PROGRESSO");
  return <div className="panel-glass reveal hud-card breathe-slow magnetic border-flow parallax-3d reveal-on-scroll" style={{padding:"28px 26px 26px",borderRadius:20,marginBottom:SP.lg,position:"relative",border:"1px solid "+col+"30",boxShadow:"0 24px 60px -24px rgba(0,0,0,0.65), 0 0 60px -20px "+col+"40, inset 0 1px 0 rgba(255,255,255,0.06)"}}>
    <div className="scan-overlay" />
    <div className="scan-sweep" />
    <div style={Object.assign({},TOP_LINE(col),{height:1,opacity:0.7})} />
    <div style={{position:"absolute",top:0,right:0,width:340,height:340,background:"radial-gradient(circle at top right, "+col+"30, transparent 65%)",pointerEvents:"none",animation:"auroraShift 20s ease-in-out infinite"}} />
    <div style={{position:"absolute",bottom:0,left:0,width:240,height:240,background:"radial-gradient(circle at bottom left, "+col2+"18, transparent 65%)",pointerEvents:"none"}} />
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:SP.md,position:"relative",flexWrap:"wrap",gap:8}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span className="live-dot" style={{background:col,boxShadow:"0 0 8px "+col+",0 0 14px "+col+"60"}} />
        <span style={{fontFamily:FF.mono,fontSize:11,color:col,letterSpacing:"0.22em",textTransform:"uppercase",fontWeight:500}}>◇ panorama · {statusLabel}</span>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <span className="tag-mono" style={{background:col+"15",borderColor:col+"35",color:col}}>{trend.toUpperCase()}</span>
        {metP && metP.total > 0 && <span className={pctMeta >= 100 ? "tag-mono tag-up" : "tag-mono"}>{pctMeta.toFixed(0)}%</span>}
      </div>
    </div>
    <div className="serif-title lift-1" style={{fontSize:"clamp(22px, 3.2vw, 28px)",fontStyle:"italic",color:T.text,lineHeight:1.25,marginBottom:SP.lg,maxWidth:"90%",position:"relative",letterSpacing:"-0.015em"}}>{narrative}</div>
    <div style={{display:"flex",alignItems:"baseline",gap:SP.md,flexWrap:"wrap",position:"relative",marginBottom:14}}>
      {privateMode ? <span style={{fontSize:"clamp(44px, 8vw, "+FS.hero+"px)",fontWeight:300,letterSpacing:"-0.035em",lineHeight:1,fontFamily:"'Instrument Serif',serif",color:col}}>•••.•••</span> :
        <span className="lift-3" style={{position:"relative",display:"inline-flex",alignItems:"baseline"}}>
          <span style={{fontFamily:FF.mono,fontSize:"clamp(28px, 5vw, 36px)",color:col,marginRight:6,filter:"drop-shadow(0 0 8px "+col+"60)"}}>{sinal}R$</span>
          <FlipNumber value={Math.abs(numHero)} duration={1400} size={typeof window !== "undefined" ? Math.min(56, Math.round((window.innerWidth || 800) * 0.085)) : 44} color={trend==="celebration" ? "#FFFFFF" : col} prefix="" style={{filter:"drop-shadow(0 0 12px "+col+"50)"}} />
        </span>
      }
      <div style={{fontFamily:FF.mono,fontSize:FS.mono,color:T.muted,letterSpacing:"0.14em",textTransform:"uppercase"}}>{label}</div>
    </div>
    {trend === "celebration" && !privateMode && <CelebrationBurst show={true} color={T.green} color2={T.cyan} />}
    {metP && metP.total > 0 && !privateMode && <div style={{position:"relative",marginTop:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <span style={{fontFamily:FF.mono,fontSize:10,color:T.dim,letterSpacing:"1.5px",textTransform:"uppercase"}}>PROGRESS_BAR</span>
        <span style={{fontFamily:FF.mono,fontSize:11,color:col,letterSpacing:"0.1em"}}>{f$(metP.atual)} / {f$(metP.total)}</span>
      </div>
      <div style={{position:"relative",height:6,background:"rgba(0,0,0,0.4)",borderRadius:3,overflow:"hidden",border:"1px solid "+col+"20"}}>
        <div style={{position:"absolute",top:0,left:0,bottom:0,width:pctMeta+"%",background:"linear-gradient(90deg, "+col+", "+col2+")",borderRadius:3,boxShadow:"0 0 12px "+col+"80",transition:"width 1s cubic-bezier(0.2,0.8,0.2,1)"}} />
        <div style={{position:"absolute",top:0,bottom:0,left:0,right:0,background:"repeating-linear-gradient(90deg, transparent 0px, transparent 8px, rgba(255,255,255,0.04) 8px, rgba(255,255,255,0.04) 9px)",pointerEvents:"none"}} />
      </div>
    </div>}
    <div className="data-line" style={{marginTop:14,opacity:0.5}} />
  </div>;
}


export default function App() {
  var _db = useState(DEF); var db = _db[0]; var setDB = _db[1];
  var _mes = useState(4); var mes = _mes[0]; var setMes = _mes[1];
  var _ano = useState(2026); var ano = _ano[0]; var setAno = _ano[1];
  var _tab = useState("visao"); var tab = _tab[0]; var setTab = _tab[1];
  var _st = useState(null); var st = _st[0]; var setSt = _st[1];
  var _modal = useState(null); var modal = _modal[0]; var setModal = _modal[1];
  var _cfm = useState(null); var cfm = _cfm[0]; var setCfm = _cfm[1];
  var _busca = useState(""); var busca = _busca[0]; var setBusca = _busca[1];
  var _gSearch = useState(""); var gSearch = _gSearch[0]; var setGSearch = _gSearch[1];
  var _fTipo = useState(""); var fTipo = _fTipo[0]; var setFTipo = _fTipo[1];
  var _fStat = useState(""); var fStat = _fStat[0]; var setFStat = _fStat[1];
  var _fPg = useState(""); var fPg = _fPg[0]; var setFPg = _fPg[1];
  var _fCard = useState(""); var fCard = _fCard[0]; var setFCard = _fCard[1];
  var _fBankCards = useState(""); var fBankCards = _fBankCards[0]; var setFBankCards = _fBankCards[1];
  var _fFatStatus = useState(""); var fFatStatus = _fFatStatus[0]; var setFFatStatus = _fFatStatus[1];
  var _fDivCards = useState(""); var fDivCards = _fDivCards[0]; var setFDivCards = _fDivCards[1];
  var _privateMode = useState(false); var privateMode = _privateMode[0]; var setPrivateMode = _privateMode[1];
  var _saudeOpen = useState(false); var saudeOpen = _saudeOpen[0]; var setSaudeOpen = _saudeOpen[1];
  var _bulkSel = useState({}); var bulkSel = _bulkSel[0]; var setBulkSel = _bulkSel[1];
  var _bulkMode = useState(false); var bulkMode = _bulkMode[0]; var setBulkMode = _bulkMode[1];
  var _aiChat = useState([]); var aiChat = _aiChat[0]; var setAiChat = _aiChat[1];
  var _booting = useState(typeof window !== "undefined" ? !sessionStorage.getItem("cojur_booted") : false); var booting = _booting[0]; var setBooting = _booting[1];
  var _achPanelOpen = useState(false); var achPanelOpen = _achPanelOpen[0]; var setAchPanelOpen = _achPanelOpen[1];
  var _achQueue = useState([]); var achQueue = _achQueue[0]; var setAchQueue = _achQueue[1];
  var chatEndRef = useRef(null);
  useEffect(function() { if (chatEndRef.current) chatEndRef.current.scrollIntoView({behavior:"smooth"}); }, [aiChat]);
  useEffect(function() {
    if (typeof window === "undefined") return;
    var root = document.documentElement;
    var mx = window.innerWidth/2, my = window.innerHeight/2, tx = mx, ty = my;
    var rafId = null;
    function onMove(e){ tx = e.clientX; ty = e.clientY; }
    function loop(){
      mx += (tx - mx) * 0.15;
      my += (ty - my) * 0.15;
      root.style.setProperty("--mx", mx + "px");
      root.style.setProperty("--my", my + "px");
      rafId = requestAnimationFrame(loop);
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    loop();
    return function(){
      window.removeEventListener("pointermove", onMove);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);
  useEffect(function(){
    if (typeof window === "undefined") return;
    function onMove(e){
      var t = e.target;
      var foundMag = null;
      var foundPar = null;
      var node = t;
      while (node && node !== document.body) {
        if (node.classList) {
          if (!foundMag && node.classList.contains("magnetic")) foundMag = node;
          if (!foundPar && node.classList.contains("parallax-3d")) foundPar = node;
        }
        node = node.parentElement;
      }
      if (foundMag) {
        var rm = foundMag.getBoundingClientRect();
        foundMag.style.setProperty("--mx", (e.clientX - rm.left) + "px");
        foundMag.style.setProperty("--my", (e.clientY - rm.top) + "px");
      }
      if (foundPar) {
        var rp = foundPar.getBoundingClientRect();
        var px = (e.clientX - rp.left) / rp.width;
        var py = (e.clientY - rp.top) / rp.height;
        var ry = (px - 0.5) * 10;
        var rx = (0.5 - py) * 8;
        foundPar.style.setProperty("--rx", ry + "deg");
        foundPar.style.setProperty("--ry", rx + "deg");
      }
    }
    function onLeave(e){
      var node = e.target;
      while (node && node !== document.body) {
        if (node.classList && node.classList.contains("parallax-3d")) {
          node.style.setProperty("--rx", "0deg");
          node.style.setProperty("--ry", "0deg");
          break;
        }
        node = node.parentElement;
      }
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave, true);
    return function(){
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave, true);
    };
  }, []);
  useEffect(function(){
    if (booting) return;
    var unlocked = (db && db.achievements) || {};
    var newly = [];
    ACHIEVEMENTS.forEach(function(a){
      if (!unlocked[a.id]) {
        try { if (a.check(db)) newly.push(a); } catch(e) {}
      }
    });
    if (newly.length > 0) {
      var nextUnlocked = Object.assign({}, unlocked);
      newly.forEach(function(a){ nextUnlocked[a.id] = Date.now(); });
      sv(Object.assign({}, db, { achievements: nextUnlocked }));
      setAchQueue(function(prev){ return prev.concat(newly); });
    }
  }, [db.lancamentos, db.metas, db.investimentos, db.cartoes, db.contas, db.dividas, booting]);
  useEffect(function(){
    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return;
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (en.isIntersecting) {
          en.target.classList.add("is-visible");
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    function attach(){
      var nodes = document.querySelectorAll(".reveal-on-scroll:not(.is-visible)");
      nodes.forEach(function(n){ io.observe(n); });
    }
    attach();
    var iv = setInterval(attach, 700);
    return function(){ clearInterval(iv); io.disconnect(); };
  }, [tab, mes, ano]);
  var _liveTime = useState(""); var liveTime = _liveTime[0]; var setLiveTime = _liveTime[1];
  useEffect(function() {
    function updateTime() {
      var d = new Date();
      setLiveTime(String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0") + ":" + String(d.getSeconds()).padStart(2,"0"));
    }
    updateTime();
    var iv = setInterval(updateTime, 1000);
    return function(){ clearInterval(iv); };
  }, []);
  useEffect(function() {
    if (typeof window === "undefined") return;
    function handleMove(e) {
      var el = e.target.closest ? e.target.closest("[data-tilt]") : null;
      if (!el) return;
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width/2;
      var cy = r.top + r.height/2;
      var dx = (e.clientX - cx) / r.width;
      var dy = (e.clientY - cy) / r.height;
      el.style.transform = "perspective(1200px) rotateY(" + (dx * 5) + "deg) rotateX(" + (-dy * 5) + "deg) translateZ(0)";
      el.style.transition = "transform 0.1s ease-out";
    }
    function handleLeave(e) {
      var el = e.target.closest ? e.target.closest("[data-tilt]") : null;
      if (!el) return;
      el.style.transform = "perspective(1000px) rotateY(0deg) rotateX(0deg) translateZ(0)";
      el.style.transition = "transform 0.5s cubic-bezier(0.2,0.8,0.2,1)";
    }
    document.addEventListener("pointermove", handleMove, { passive: true });
    document.addEventListener("pointerleave", handleLeave, true);
    return function() {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerleave", handleLeave, true);
    };
  }, []);
  useEffect(function() {
    if (typeof IntersectionObserver === "undefined") return;
    var obs = new IntersectionObserver(function(entries) {
      entries.forEach(function(e) {
        if (e.isIntersecting) {
          e.target.classList.add("reveal-in");
          obs.unobserve(e.target);
        }
      });
    }, { rootMargin: "0px 0px -40px 0px", threshold: 0.05 });
    var tid = setTimeout(function() {
      document.querySelectorAll(".reveal:not(.reveal-in)").forEach(function(el) { obs.observe(el); });
    }, 80);
    return function() {
      clearTimeout(tid);
      obs.disconnect();
    };
  }, [tab, mes, ano]);
  useEffect(function() {
    if (typeof document === "undefined") return;
    function addRipple(e) {
      var host = e.target.closest ? e.target.closest(".ripple-host") : null;
      if (!host) return;
      var rect = host.getBoundingClientRect();
      var size = Math.max(rect.width, rect.height);
      var x = e.clientX - rect.left - size/2;
      var y = e.clientY - rect.top - size/2;
      var r = document.createElement("span");
      r.className = "ripple";
      r.style.width = size + "px";
      r.style.height = size + "px";
      r.style.left = x + "px";
      r.style.top = y + "px";
      host.appendChild(r);
      setTimeout(function() { if(r.parentNode) r.parentNode.removeChild(r); }, 650);
    }
    document.addEventListener("pointerdown", addRipple);
    return function() { document.removeEventListener("pointerdown", addRipple); };
  }, []);
  // === v15: Command Palette (⌘K) ===
  var _cmdOpen = useState(false); var cmdOpen = _cmdOpen[0]; var setCmdOpen = _cmdOpen[1];
  useEffect(function(){
    if (typeof window === "undefined") return;
    function onKey(e){
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen(function(p){ return !p; });
      }
    }
    window.addEventListener("keydown", onKey);
    return function(){ window.removeEventListener("keydown", onKey); };
  }, []);
  // === v15: Signature moment (celebra meta batida) ===
  var _lastCelebrated = useState(""); var lastCelebrated = _lastCelebrated[0]; var setLastCelebrated = _lastCelebrated[1];
  var _aiInput = useState(""); var aiInput = _aiInput[0]; var setAiInput = _aiInput[1];
  var _aiLoading = useState({}); var aiLoadMap = _aiLoading[0]; var setAiLoadMap = _aiLoading[1];
  function isAiLoading(key) { return key ? !!aiLoadMap[key] : Object.values(aiLoadMap).some(Boolean); }
  function setAiLoad(key, v) { setAiLoadMap(function(prev){ var n = {...prev}; n[key]=v; return n; }); }
  var aiLoading = Object.values(aiLoadMap).some(Boolean);
  var _aiInsights = useState(""); var aiInsights = _aiInsights[0]; var setAiInsights = _aiInsights[1];
  var _aiPlan = useState(""); var aiPlan = _aiPlan[0]; var setAiPlan = _aiPlan[1];
  var _aiCatSug = useState(""); var aiCatSug = _aiCatSug[0]; var setAiCatSug = _aiCatSug[1];
  var _aiReport = useState(""); var aiReport = _aiReport[0]; var setAiReport = _aiReport[1];
  var _aiCoach = useState(""); var aiCoach = _aiCoach[0]; var setAiCoach = _aiCoach[1];
  var _aiSim = useState(""); var aiSim = _aiSim[0]; var setAiSim = _aiSim[1];
  var _aiSimQ = useState(""); var aiSimQ = _aiSimQ[0]; var setAiSimQ = _aiSimQ[1];
  var _aiNlpInput = useState(""); var aiNlpInput = _aiNlpInput[0]; var setAiNlpInput = _aiNlpInput[1];
  var _aiAnom = useState(""); var aiAnom = _aiAnom[0]; var setAiAnom = _aiAnom[1];
  var _aiPredict = useState(""); var aiPredict = _aiPredict[0]; var setAiPredict = _aiPredict[1];
  var _aiEcon = useState(""); var aiEcon = _aiEcon[0]; var setAiEcon = _aiEcon[1];
  var _aiDebtCmp = useState(""); var aiDebtCmp = _aiDebtCmp[0]; var setAiDebtCmp = _aiDebtCmp[1];
  var _aiBudget = useState(""); var aiBudget = _aiBudget[0]; var setAiBudget = _aiBudget[1];
  var _aiDiag = useState(""); var aiDiag = _aiDiag[0]; var setAiDiag = _aiDiag[1];
  var _aiWeekly = useState(""); var aiWeekly = _aiWeekly[0]; var setAiWeekly = _aiWeekly[1];
  var _aiPatrim = useState(""); var aiPatrim = _aiPatrim[0]; var setAiPatrim = _aiPatrim[1];
  var _aiCar = useState(""); var aiCar = _aiCar[0]; var setAiCar = _aiCar[1];
  var _aiBankMeet = useState(""); var aiBankMeet = _aiBankMeet[0]; var setAiBankMeet = _aiBankMeet[1];
  var _aiAllProg = useState(0); var aiAllProg = _aiAllProg[0]; var setAiAllProg = _aiAllProg[1];
  var _aiCache = useState({}); var aiCache = _aiCache[0]; var setAiCache = _aiCache[1];
  function getAiCacheKey(prefix) { return prefix + "_" + mes + "_" + ano; }
  function getCachedAi(prefix) { return aiCache[getAiCacheKey(prefix)] || null; }
  function setCachedAi(prefix, val) { setAiCache(function(prev) { var n = {...prev}; n[getAiCacheKey(prefix)] = val; return n; }); }
  var _aiHistory = useState([]); var aiHistory = _aiHistory[0]; var setAiHistory = _aiHistory[1];
  var _darkMode = useState(true); var darkMode = _darkMode[0]; var setDarkMode = _darkMode[1];
  var _fTitular = useState(""); var fTitular = _fTitular[0]; var setFTitular = _fTitular[1];
  var _swipeId = useState(""); var swipeId = _swipeId[0]; var setSwipeId = _swipeId[1];
  var _aiRecur = useState(""); var aiRecur = _aiRecur[0]; var setAiRecur = _aiRecur[1];
  var _showAporteModal = useState(false); var showAporteModal = _showAporteModal[0]; var setShowAporteModal = _showAporteModal[1];
  var _iaTabLoaded = useState(false); var iaTabLoaded = _iaTabLoaded[0]; var setIaTabLoaded = _iaTabLoaded[1];
  var _pieFilter = useState(""); var pieFilter = _pieFilter[0]; var setPieFilter = _pieFilter[1];
  var _calDay = useState(0); var calDay = _calDay[0]; var setCalDay = _calDay[1];
  var _quickInput = useState(""); var quickInput = _quickInput[0]; var setQuickInput = _quickInput[1];
  var _quickShow = useState(false); var quickShow = _quickShow[0]; var setQuickShow = _quickShow[1];
  var _coachSub = useState("plano"); var coachSub = _coachSub[0]; var setCoachSub = _coachSub[1];
  var _txCount = useState(0); var txCount = _txCount[0]; var setTxCount = _txCount[1];
  var _scoreInput = useState(763); var scoreInput = _scoreInput[0]; var setScoreInput = _scoreInput[1];
  var _patrimInput = useState(25000); var patrimInput = _patrimInput[0]; var setPatrimInput = _patrimInput[1];
  var _cardSpend = useState({sant:0,itau:0,brad:0}); var cardSpend = _cardSpend[0]; var setCardSpend = _cardSpend[1];
  var _cardLimits = useState({sant:11343,itau:18500,brad:5000}); var cardLimits = _cardLimits[0]; var setCardLimits = _cardLimits[1];
  T = darkMode ? T_DARK : T_LIGHT;
  var fr = useRef(null);
  var touchStart = useRef(null);
  var touchEnd = useRef(null);

  function onTouchStart(e) { touchStart.current = e.targetTouches[0].clientX; touchEnd.current = null; }
  function onTouchMove(e) { touchEnd.current = e.targetTouches[0].clientX; }
  function onTouchEnd() {
    if (!touchStart.current || !touchEnd.current) return;
    var diff = touchStart.current - touchEnd.current;
    if (Math.abs(diff) > 60) {
      var idx = -1;
      var idx = -1;
      for (let ti = 0; ti < TABS.length; ti++) { if (TABS[ti].id === tab) { idx = ti; break; } }
      if (diff > 0 && idx < TABS.length - 1) setTab(TABS[idx + 1].id);
      else if (diff < 0 && idx > 0) setTab(TABS[idx - 1].id);
    }
    touchStart.current = null; touchEnd.current = null;
  }

  function flash(m) { setSt(m); setTimeout(function(){setSt(null)}, 2200); }

  // v14: Auto-scroll chat
  useEffect(function() {
    if (chatEndRef.current) chatEndRef.current.scrollIntoView({behavior:"smooth"});
  }, [aiChat]);

  useEffect(function() {
    var r = doLoad();
    if (r) { var n = norm(r); if (n) { setDB(n); flash("Dados restaurados!"); } }
  }, []);

  // === v18: Cache buster — desregistra service workers antigos e limpa caches ===
  useEffect(function(){
    if (typeof window === "undefined") return;
    // Versao atual da build, usada para detectar usuario com versao antiga em cache
    var BUILD_TAG = "vault-v18-" + (new Date().toISOString().slice(0,10));
    try {
      var lastSeen = localStorage.getItem("vault_build_tag");
      if (lastSeen && lastSeen !== BUILD_TAG) {
        // detectou versao nova, limpa caches do navegador
        if ("caches" in window) {
          caches.keys().then(function(keys){
            keys.forEach(function(k){ caches["delete"](k); });
          });
        }
        // Recarga forcada uma vez
        if (!sessionStorage.getItem("vault_force_reloaded")) {
          sessionStorage.setItem("vault_force_reloaded", "1");
          setTimeout(function(){ window.location.reload(); }, 300);
        }
      }
      localStorage.setItem("vault_build_tag", BUILD_TAG);
    } catch(e) {}
    // Desregistra service workers antigos (PWA pode estar servindo HTML cacheado)
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        navigator.serviceWorker.getRegistrations().then(function(regs){
          regs.forEach(function(r){
            // mantem somente se for o sw-killer da raiz
            try { r.unregister(); } catch(e){}
          });
        });
      }
    } catch(e){}
    // Meta cache-control e pragma para tentar evitar cache HTML
    try {
      var head = document.head;
      [{name:"cache-control",content:"no-cache, no-store, must-revalidate"},
       {name:"pragma",content:"no-cache"},
       {name:"expires",content:"0"}].forEach(function(m){
        if (!document.querySelector('meta[http-equiv="'+m.name+'"]')) {
          var el = document.createElement("meta");
          el.httpEquiv = m.name; el.content = m.content;
          head.appendChild(el);
        }
      });
    } catch(e){}
  }, []);

  useEffect(function() {
    // iOS PWA icon as SVG (nitid, escala infinitamente)
    var iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#020208"/><stop offset="100%" stop-color="#0A0A1A"/></linearGradient></defs><rect width="180" height="180" rx="40" fill="url(#g)"/><rect x="20" y="20" width="140" height="140" rx="28" fill="none" stroke="#00E5FF" stroke-width="1.5" opacity="0.3"/><text x="90" y="108" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Inter,sans-serif" font-size="58" font-weight="900" fill="#00E5FF" letter-spacing="-2">CV</text><text x="90" y="135" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="11" font-weight="700" fill="#00E5FF" opacity="0.6" letter-spacing="3">VAULT</text></svg>';
    var iconDataUrl = "data:image/svg+xml;utf8," + encodeURIComponent(iconSvg);
    var metas = [
      {name:"apple-mobile-web-app-capable", content:"yes"},
      {name:"mobile-web-app-capable", content:"yes"},
      {name:"apple-mobile-web-app-status-bar-style", content:"black-translucent"},
      {name:"apple-mobile-web-app-title", content:"COJUR Vault"},
      {name:"application-name", content:"COJUR Vault"},
      {name:"theme-color", content:"#020208"},
      {name:"format-detection", content:"telephone=no"},
      {name:"viewport", content:"width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"}
    ];
    var created = [];
    metas.forEach(function(m) {
      // Remove qualquer viewport existente antes de criar o novo
      if (m.name === "viewport") {
        var existing = document.querySelector('meta[name="viewport"]');
        if (existing) existing.remove();
      }
      var el = document.createElement("meta");
      el.name = m.name;
      el.content = m.content;
      document.head.appendChild(el);
      created.push(el);
    });
    // Apple touch icons em vários tamanhos
    var touchIconSizes = ["57x57","60x60","72x72","76x76","114x114","120x120","144x144","152x152","180x180"];
    touchIconSizes.forEach(function(size) {
      var link = document.createElement("link");
      link.rel = "apple-touch-icon";
      link.setAttribute("sizes", size);
      link.href = iconDataUrl;
      document.head.appendChild(link);
      created.push(link);
    });
    // Favicon
    var favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.href = iconDataUrl;
    favicon.type = "image/svg+xml";
    document.head.appendChild(favicon);
    created.push(favicon);
    // Estilos globais: safe-area (notch/home indicator) + animações + tap highlight
    var styleTag = document.createElement("style");
    styleTag.textContent = [
      "@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}",
      "@keyframes tabFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}",
      "@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}",
      "@keyframes slideIn{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:translateX(0)}}",
      ".tab-content{animation:tabFade 0.25s ease-out}",
      "@keyframes vv-dotPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(1.35)}}",
      "@keyframes vv-shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}",
      "@keyframes vv-breath{0%,100%{box-shadow:0 0 18px rgba(0,245,212,0.18), inset 0 1px 0 rgba(255,255,255,0.06)}50%{box-shadow:0 0 36px rgba(0,245,212,0.40), inset 0 1px 0 rgba(255,255,255,0.10)}}",
      "@keyframes vv-holoSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}",
      "@keyframes vv-topLine{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}",
      "@keyframes vv-aurora{0%,100%{transform:translate(0,0) rotate(0deg)}50%{transform:translate(-2%,-1%) rotate(180deg)}}",
      "@keyframes vv-confettiFall{0%{transform:translate(0,0) rotate(0)}100%{transform:translate(var(--vv-cx,0px),120vh) rotate(720deg);opacity:0}}",
      "@keyframes vv-bleed{0%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(40px)}}",
      "@keyframes vv-signalBar{0%,100%{transform:scaleY(0.3)}50%{transform:scaleY(1)}}",
      "@keyframes vv-spotIn{from{opacity:0.6;filter:saturate(0.85)}to{opacity:1;filter:saturate(1)}}",
      "@keyframes vv-numFlash{0%{transform:scale(1)}30%{transform:scale(1.06);color:#A8FF3E;text-shadow:0 0 16px rgba(168,255,62,0.5)}100%{transform:scale(1);text-shadow:none}}",
      "@keyframes vv-numFlashRed{0%{transform:scale(1)}30%{transform:scale(1.08);color:#FF5A1F;text-shadow:0 0 18px rgba(255,90,31,0.55)}100%{transform:scale(1);text-shadow:none}}",
      ".vv-shimmer{background:linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(0,245,212,0.18) 50%, rgba(255,255,255,0.04) 100%);background-size:200% 100%;animation:vv-shimmer 1.4s linear infinite;border-radius:8px}",
      ".vv-breath{animation:vv-breath 4s ease-in-out infinite}",
      ".vv-topline{position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,#00F5D4,transparent);overflow:hidden;pointer-events:none}",
      ".vv-topline::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent 30%,rgba(255,255,255,0.85) 50%,transparent 70%);animation:vv-topLine 3.5s ease-in-out infinite}",
      ".vv-holo{position:absolute;inset:-1px;border-radius:inherit;padding:1px;background:conic-gradient(from 0deg,#00F5D4,#7B4CFF,#FF00E5,#00C2FF,#A8FF3E,#00F5D4);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:vv-holoSpin 8s linear infinite;opacity:0.55;pointer-events:none}",
      ".vv-aurora{position:fixed;inset:-20%;z-index:0;pointer-events:none;background:radial-gradient(ellipse at 20% 30%, rgba(0,245,212,0.10), transparent 45%),radial-gradient(ellipse at 80% 70%, rgba(123,76,255,0.10), transparent 45%),radial-gradient(ellipse at 60% 20%, rgba(255,0,229,0.06), transparent 45%);animation:vv-aurora 30s ease-in-out infinite;filter:blur(40px)}",
      ".vv-aurora.light{background:radial-gradient(ellipse at 20% 30%, rgba(0,168,204,0.08), transparent 45%),radial-gradient(ellipse at 80% 70%, rgba(136,56,238,0.06), transparent 45%);filter:blur(50px)}",
      ".vv-pulse-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;animation:vv-dotPulse 1.6s ease-in-out infinite;box-shadow:0 0 8px currentColor}",
      ".vv-num-flash{animation:vv-numFlash 0.6s ease-out}",
      ".vv-num-bleed{animation:vv-numFlashRed 0.7s ease-out}",
      ".vv-confetti{position:fixed;top:30%;left:50%;width:10px;height:14px;border-radius:2px;pointer-events:none;z-index:9999;animation:vv-confettiFall 1.6s cubic-bezier(0.2,0.6,0.4,1) forwards}",
      ".vv-signal{display:inline-flex;align-items:flex-end;gap:2px;height:14px}",
      ".vv-signal>span{width:3px;background:currentColor;border-radius:1px;transform-origin:bottom;animation:vv-signalBar 1.2s ease-in-out infinite}",
      ".vv-signal>span:nth-child(1){height:35%;animation-delay:0s}.vv-signal>span:nth-child(2){height:60%;animation-delay:0.15s}.vv-signal>span:nth-child(3){height:85%;animation-delay:0.3s}.vv-signal>span:nth-child(4){height:100%;animation-delay:0.45s}",
      ".vv-spot-in{animation:vv-spotIn 0.6s ease-out}",
      ".vv-glass{backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);background:rgba(10,14,28,0.55);border:1px solid rgba(255,255,255,0.08)}",
      ".vv-glass.light{background:rgba(255,255,255,0.55);border:1px solid rgba(0,0,0,0.06)}",
      ".vv-spark-pt{animation:vv-dotPulse 1.4s ease-in-out infinite}",
      "@media (prefers-reduced-motion: reduce){.vv-breath,.vv-aurora,.vv-topline::after,.vv-holo,.vv-pulse-dot,.vv-signal>span,.vv-confetti,.vv-spark-pt{animation:none !important}}",
      "html,body{margin:0;padding:0;overscroll-behavior:none;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;background:#020208}",
      "body{padding-top:env(safe-area-inset-top);padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)}",
      "input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}",
      "button{-webkit-appearance:none;appearance:none}",
      "input,select,textarea{font-size:16px !important}",
      "*{-webkit-overflow-scrolling:touch}"
    ].join("");
    document.head.appendChild(styleTag);
    created.push(styleTag);
    // Manifest PWA com ícones múltiplos e shortcuts
    var manifestData = {
      name: "COJUR Vault",
      short_name: "Vault",
      description: "Gestão financeira pessoal com IA",
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#020208",
      theme_color: "#00E5FF",
      categories: ["finance","productivity"],
      lang: "pt-BR",
      dir: "ltr",
      icons: [
        {src: iconDataUrl, sizes: "192x192", type: "image/svg+xml", purpose: "any"},
        {src: iconDataUrl, sizes: "512x512", type: "image/svg+xml", purpose: "any"},
        {src: iconDataUrl, sizes: "192x192", type: "image/svg+xml", purpose: "maskable"}
      ]
    };
    var link = document.createElement("link");
    link.rel = "manifest";
    link.href = "data:application/json;base64," + btoa(unescape(encodeURIComponent(JSON.stringify(manifestData))));
    document.head.appendChild(link);
    created.push(link);
    // Registra Service Worker se existir (fallback silencioso em dev/Vercel sem sw.js)
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then(function(reg) {
        // Check for updates a cada visita
        reg.update();
      }).catch(function() {
        // Silencioso: se não existir sw.js, segue funcionando como app normal
      });
    }
    // Previne double-tap zoom em iOS
    var lastTouch = 0;
    var preventDoubleTap = function(e) {
      var now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    };
    document.addEventListener("touchend", preventDoubleTap, {passive: false});
    return function() {
      created.forEach(function(el) { try { document.head.removeChild(el); } catch(e) {} });
      document.removeEventListener("touchend", preventDoubleTap);
    };
  }, []);

  function sv(nd) { setDB(nd); doSave(nd); setSt("Salvo \u2713"); setTimeout(function(){setSt(null)}, 1500); }

  // === v18: Cloud Sync (Supabase + Google) ===
  var cloudRemoteTsRef = useRef(null);
  function applyRemoteDb(remoteData, remoteTs) {
    if (!remoteData) return;
    // Skip se ja aplicamos esse timestamp
    if (remoteTs && cloudRemoteTsRef.current === remoteTs) return;
    cloudRemoteTsRef.current = remoteTs || null;
    var n = norm(remoteData);
    if (n) {
      setDB(n);
      doSave(n); // espelha local
      setSt("Sincronizado \u2601"); setTimeout(function(){setSt(null)}, 1500);
    }
  }
  var sync = useCloudSync(db, applyRemoteDb, doSave);

  function ups(key, item) {
    var list = db[key] || [];
    var ex = list.find(function(x){return x.id===item.id});
    var ndb = Object.assign({}, db);
    ndb[key] = ex ? list.map(function(x){return x.id===item.id?item:x}) : list.concat([item]);
    sv(ndb);
    flash(ex ? "Atualizado!" : "Adicionado!");
  }

  function del(key, id) {
    setCfm({msg:"Excluir?", fn:function(){
      var ndb = Object.assign({}, db);
      ndb[key] = (db[key]||[]).filter(function(x){return x.id!==id});
      sv(ndb);
      flash("Removido!");
      setCfm(null);
    }});
  }

  function saveLanc(l, totalParc) {
    var r = gMA(l.data);
    var metodo = l.tipo === "receita" ? "pix" : (l.pg || (l.cartaoId ? "cartao" : "pix"));
    var base = Object.assign({}, l, {mes:r.mes, ano:r.ano, pg:metodo, cartaoId:l.tipo === "receita" || metodo !== "cartao" ? "" : (l.cartaoId||"")});
    var nL = (db.lancamentos||[]).slice();
    var ex = nL.find(function(x){return x.id===base.id});
    if (ex) {
      nL = nL.map(function(x){return x.id===base.id?base:x});
    } else {
      nL.push(base);
      if (totalParc > 1) {
        var pA = base.pA || 1;
        for (let k =pA+1; k<=totalParc; k++) {
          var nm = r.mes + (k - pA);
          var na = r.ano;
          while (nm > 12) { nm -= 12; na++; }
          var dt = na + "-" + (nm<10?"0":"") + nm + "-" + base.data.slice(8);
          nL.push(Object.assign({}, base, {id:uid(), data:dt, mes:nm, ano:na, pA:k, status:"pendente"}));
        }
      }
    }
    sv(Object.assign({}, db, {lancamentos:nL}));
    flash("Salvo!" + (totalParc>1 && !ex ? " + parcelas futuras" : ""));
  }

  function togPago(id) {
    if (navigator.vibrate) navigator.vibrate(10);
    var lanc = (db.lancamentos||[]).find(function(l){return l.id===id});
    if (!lanc) return;
    var novoStatus = lanc.status === "pago" ? "pendente" : "pago";
    var ndb = Object.assign({}, db, {lancamentos: (db.lancamentos||[]).map(function(l){
      return l.id===id ? Object.assign({},l,{status:novoStatus}) : l;
    })});
    
    if ((lanc.tipo === "parcela" || lanc.pT > 0) && lanc.cat === "c8") {
      var descBase = String(lanc.desc||"").replace(/\s*\d+\/\d+$/, "").replace(/\s*\(copia\)$/, "").trim().toLowerCase();
      ndb.dividas = (ndb.dividas||[]).map(function(d) {
        if (String(d.nome||"").toLowerCase().indexOf(descBase) >= 0 || descBase.indexOf(String(d.nome||"").toLowerCase()) >= 0) {
          var delta = novoStatus === "pago" ? (lanc.valor||0) : -(lanc.valor||0);
          return Object.assign({}, d, {pago: Math.max(0, (d.pago||0) + delta)});
        }
        return d;
      });
    }
    sv(ndb);
  }

  function duplicateLanc(lanc) {
    var novo = Object.assign({}, lanc, {id: uid(), status: "pendente", desc: lanc.desc + " (copia)", rec: false, virtual: undefined, pT: 0, pA: 0});
    sv(Object.assign({}, db, {lancamentos: (db.lancamentos||[]).concat([novo])}));
    flash("Lançamento duplicado!");
  }

  function bulkToggle(id) {
    var n = Object.assign({}, bulkSel);
    if (n[id]) { delete n[id]; } else { n[id] = true; }
    setBulkSel(n);
  }

  function bulkMarkPago() {
    var ids = Object.keys(bulkSel);
    if (ids.length === 0) { flash("Nenhum lançamento selecionado"); return; }
    sv(Object.assign({}, db, {lancamentos: (db.lancamentos||[]).map(function(l){
      return bulkSel[l.id] ? Object.assign({},l,{status:"pago"}) : l;
    })}));
    setBulkSel({});
    setBulkMode(false);
    flash(ids.length + " lançamento(s) marcado(s) como pago!");
  }

  function bulkSelectAll() {
    var n = {};
    lF.forEach(function(l) { if (!l.virtual && l.status !== "pago") n[l.id] = true; });
    setBulkSel(n);
  }

  function marcarFixasPagas() {
    var count = 0;
    var nL = (db.lancamentos||[]).map(function(l) {
      if (l.mes === mes && l.ano === ano && l.rec && l.tipo !== "receita" && l.status !== "pago") {
        count++;
        return Object.assign({}, l, {status: "pago"});
      }
      return l;
    });
    if (count === 0) { flash("Todas ja estao pagas!"); return; }
    sv(Object.assign({}, db, {lancamentos: nL}));
    flash(count + " despesa(s) fixa(s) marcada(s) como paga(s)!");
  }

  function updConta(id, v) {
    sv(Object.assign({}, db, {contas: db.contas.map(function(c){
      return c.id===id ? Object.assign({},c,{saldo:v}) : c;
    })}));
    flash("Atualizado!");
  }

  function togRatingTask(id) {
    var chave = ano + "-" + (mes<10?"0":"") + mes;
    var rm = Object.assign({}, db.ratingMensal || {});
    rm[chave] = Object.assign({}, rm[chave] || {}, {});
    rm[chave][id] = !rm[chave][id];
    sv(Object.assign({}, db, {ratingMensal:rm}));
  }

  function updRatingObs(txt) {
    var chave = ano + "-" + (mes<10?"0":"") + mes;
    var rm = Object.assign({}, db.ratingMensal || {});
    rm[chave] = Object.assign({}, rm[chave] || {});
    rm[chave]._obs = txt;
    sv(Object.assign({}, db, {ratingMensal:rm}));
  }

  function updRatingTentativa(bankKey, txt) {
    var chave = ano + "-" + (mes<10?"0":"") + mes;
    var rm = Object.assign({}, db.ratingMensal || {});
    rm[chave] = Object.assign({}, rm[chave] || {});
    rm[chave]["_tent_" + bankKey] = txt;
    sv(Object.assign({}, db, {ratingMensal:rm}));
  }

  function setBancoFoco(val) {
    var chave = ano + "-" + (mes<10?"0":"") + mes;
    var rm = Object.assign({}, db.ratingMensal || {});
    rm[chave] = Object.assign({}, rm[chave] || {});
    rm[chave]._bancoFoco = val || "";
    sv(Object.assign({}, db, {ratingMensal:rm}));
    flash("Banco foco atualizado!");
  }

  function updCard(id, patch) {
    sv(Object.assign({}, db, {cartoes: (db.cartoes||[]).map(function(c){ return c.id===id ? Object.assign({}, c, patch) : c; })}));
  }

  function updFatManual(cardId, mesFat, anoFat, patch) {
    var key = fatManualKey(cardId, mesFat, anoFat);
    var fm = Object.assign({}, db.faturasManuais || {});
    fm[key] = Object.assign({}, fm[key] || {}, patch);
    sv(Object.assign({}, db, {faturasManuais: fm}));
  }

  function resetFatManual(cardId, mesFat, anoFat) {
    var key = fatManualKey(cardId, mesFat, anoFat);
    var fm = Object.assign({}, db.faturasManuais || {});
    if (fm[key]) delete fm[key].valorManual;
    if (fm[key] && fm[key].vencDia === undefined && !fm[key].paga) delete fm[key];
    sv(Object.assign({}, db, {faturasManuais: fm}));
  }

  function togFatPaga(cardId, mesFat, anoFat, total, vencDate) {
    var meta = getFatManual(db, cardId, mesFat, anoFat);
    var proxPaga = !meta.paga;
    updFatManual(cardId, mesFat, anoFat, {paga: proxPaga, pagoEm: proxPaga ? hj() : "", pagoValor: proxPaga ? total : undefined, pagoVencOriginal: proxPaga && vencDate ? isoDt(vencDate) : ""});
  }

  function resetFatVenc(cardId, mesFat, anoFat, vencPadrao) {
    var key = fatManualKey(cardId, mesFat, anoFat);
    var fm = Object.assign({}, db.faturasManuais || {});
    if (fm[key]) delete fm[key].vencDia;
    if (fm[key] && fm[key].valorManual === undefined && !fm[key].paga) delete fm[key];
    sv(Object.assign({}, db, {faturasManuais: fm}));
  }

    function askMarcarFatura(cardId, mesFat, anoFat, total, vencDate, paga) {
    setCfm({msg:paga ? "Desmarcar esta fatura como paga?" : "Marcar esta fatura como paga?", fn:function(){ togFatPaga(cardId, mesFat, anoFat, total, vencDate); setCfm(null); }});
  }

  function askResetFatValor(cardId, mesFat, anoFat) {
    setCfm({msg:"Voltar o valor desta fatura para o cálculo automático?", fn:function(){ resetFatManual(cardId, mesFat, anoFat); setCfm(null); }});
  }

  function askResetFatVenc(cardId, mesFat, anoFat) {
    setCfm({msg:"Voltar o vencimento desta fatura para o padrao do cartao?", fn:function(){ resetFatVenc(cardId, mesFat, anoFat); setCfm(null); }});
  }

  function delCartaoSeguro(cardId) {
    var vinculados = (db.lancamentos||[]).filter(function(l){ return (l.cartaoId||"") === cardId; }).length;
    if (vinculados > 0) { flash("Cartao vinculado a lancamentos. Remova ou altere os vinculos antes de excluir."); return; }
    del("cartoes", cardId);
  }

  function handleFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var parsed = JSON.parse(e.target.result);
        var validation = validateSchema(parsed);
        if (!validation.valid) { flash("Erro: " + validation.error); return; }
        var n = norm(parsed);
        if (!n) { flash("Arquivo inválido"); return; }
        setCfm({msg:"Substituir todos os dados? Um backup automático será salvo.", fn:function(){
          saveBackup(db);
          sv(n);
          flash("Importado! Backup salvo.");
          setCfm(null);
        }});
      } catch(err) { flash("Erro no arquivo"); }
    };
    reader.readAsText(file);
  }

  var _backupList = useState([]); var backupList = _backupList[0]; var setBackupList = _backupList[1];
  
  function loadBackupList() {
    listBackups().then(function(list) { setBackupList(list); });
  }

  function restoreBackup(slot) {
    var bk = backupList.find(function(b){ return b.slot === slot; });
    if (!bk || !bk.data) { flash("Backup não encontrado"); return; }
    try {
      var n = norm(bk.data);
      if (n) { sv(n); flash("Backup restaurado! (" + bk.date + ")"); }
      else { flash("Backup corrompido"); }
    } catch(e) { flash("Erro ao restaurar"); }
  }

  function hasBackup() {
    return backupList.length > 0;
  }

  function getFinCtx() {
    var r = res; var p = pv; var f = fluxo;
    return "MES: " + MSF[mes-1] + "/" + ano +
    "\nReceita: " + f$(p.receitaMes) + " | Despesas lancadas: " + f$(p.despLancadas) + " | Sobra: " + f$(p.sobraPrevista) +
    "\nFluxo PIX: " + f$(f.pix) + " | Fatura cartoes: " + f$(f.faturaDoMes) + " | Invest. fixo: " + f$(f.investFixo) +
    "\nPatrimônio liq: " + f$(pat.liq) + " | Saldo contas: " + f$(pat.sc) + " | Investido: " + f$(pat.inv) + " | Dívidas: " + f$(pat.dv) +
    "\nFixas mensais: " + f$(totalFixas) + " (" + fixas.length + " itens)" +
    "\nParcelas: " + f$(totalParcMes) + " (" + parcelas.length + " itens)" +
    "\nCartoes: " + cardsResumo.map(function(c){return c.nome+" uso "+pct(c.usoRealPct)+" limite "+f$(c.limite)}).join("; ") +
    "\nDividas ativas: " + (db.dividas||[]).map(function(d){var r=Math.max(0,d.total-d.pago);return d.nome+" rest "+f$(r)+" parc "+f$(d.parcela)}).join("; ") +
    "\nInvestimentos: " + (db.investimentos||[]).map(function(i){return i.nome+" "+f$(i.valor)+" rent "+i.rent+"%"}).join("; ") +
    "\nMetas: " + (db.metas||[]).map(function(m){var mp=metP.find(function(x){return x.id===m.id});return m.nome+" "+f$(m.valor)+" "+(mp?pct(mp.pr):"-")}).join("; ") +
    "\nRating geral: " + ratingScore + "/100 | Santander: " + planoSantander.score + " | Itau: " + planoItau.score +
    "\nSaude: " + saude.label + " " + saude.score + "/100" +
    "\nTop 5 despesas do mes: " + lancEx.filter(function(l){return l.mes===mes&&l.ano===ano&&l.tipo!=="receita"}).sort(function(a,b){return b.valor-a.valor}).slice(0,5).map(function(l){return l.desc+" "+f$(l.valor)}).join(", ");
  }

  var aiSysPrompt = "Você é um consultor financeiro pessoal integrado ao app COJUR Vault. Responda em portugues brasileiro, de forma direta e pratica. Use os dados reais fornecidos. Nunca use travessões dentro de parágrafos. Seja conciso (max 200 palavras). Formate com parágrafos curtos.";

  function sendAiMsg() {
    if (!aiInput.trim() || isAiLoading("chat")) return;
    var userMsg = aiInput.trim();
    var ctx = getFinCtx();
    var newMsgs = aiChat.concat([{role:"user",content:userMsg}]);
    setAiChat(newMsgs);
    setAiInput("");
    setAiLoad("chat", true);
    var apiMsgs = [{role:"user",content:"CONTEXTO FINANCEIRO:\n"+ctx+"\n\nPERGUNTA: "+userMsg}];
    if (newMsgs.length > 2) {
      apiMsgs = newMsgs.map(function(m,i){
        if (i===0) return {role:m.role, content:"CONTEXTO FINANCEIRO:\n"+ctx+"\n\nPERGUNTA: "+m.content};
        return {role:m.role, content:m.content};
      });
    }
    callAIChat(aiSysPrompt, apiMsgs).then(function(resp){
      setAiChat(function(prev){return prev.concat([{role:"assistant",content:resp}])});
      setAiLoad("chat", false);
    });
  }

  function generateAllParallel() {
    if (aiLoading) return;
    setAiLoadMap({insights:true, plan:true, report:true, diagnosis:true});
    setAiAllProg(0);
    var ctx = getFinCtx();
    var calls = [
      callAI("Você é um analista financeiro. Gere 4-5 insights curtos e acionaveis baseados nos dados. Cada insight em uma linha. Use dados específicos. Nunca use travessões dentro de parágrafos. Responda em portugues.", "Análise estes dados e gere insights práticos:\n" + ctx),
      callAI("Você é um planejador financeiro. Crie um plano otimizado para atingir as metas. Considere quitacao de dividas vs investimento. Seja específico com valores e prazos. Nunca use travessões dentro de parágrafos. Max 250 palavras. Português.", "Com estes dados, crie um plano otimizado para as metas:\n" + ctx),
      callAI("Você é um consultor financeiro gerando um relatório mensal profissional. Estruture em: Resumo Executivo, Receitas e Despesas, Dívidas e Parcelas, Investimentos e Metas, Rating Bancário, Recomendações. Use dados específicos. Nunca use travessões dentro de parágrafos. Max 400 palavras. Português.", "Gere o relatório financeiro de " + MSF[mes-1] + "/" + ano + ":\n" + ctx),
      callAI("Você é um médico financeiro. Faça um diagnóstico completo da saúde financeira. Avalie de 0 a 100 cada pilar: 1) Liquidez 2) Endividamento 3) Poupanca 4) Investimentos. Dê uma NOTA GERAL de 0 a 100. Nunca use travessões dentro de parágrafos. Português.", "DADOS:\n" + ctx)
    ];
    var done = 0;
    calls[0].then(function(r) { setAiInsights(r); done++; setAiAllProg(Math.round(done/4*100)); setAiLoad("insights",false); });
    calls[1].then(function(r) { setAiPlan(r); done++; setAiAllProg(Math.round(done/4*100)); setAiLoad("plan",false); });
    calls[2].then(function(r) { setAiReport(r); done++; setAiAllProg(Math.round(done/4*100)); setAiLoad("report",false); });
    calls[3].then(function(r) { setAiDiag(r); done++; setAiAllProg(Math.round(done/4*100)); setAiLoad("diagnosis",false); });
    Promise.all(calls).then(function() { setAiLoadMap({}); setAiAllProg(100); });
  }

  function generateInsights() {
    if (isAiLoading("insights")) return;
    var cached = getCachedAi("insights");
    if (cached) { setAiInsights(cached); return; }
    setAiLoad("insights", true);
    var ctx = getFinCtx();
    callAI(
      "Você é um analista financeiro. Gere 4-5 insights curtos e acionaveis baseados nos dados. Cada insight em uma linha. Use dados específicos. Nunca use travessões dentro de parágrafos. Responda em portugues.",
      "Análise estes dados e gere insights práticos:\n" + ctx
    ).then(function(r){setAiInsights(r);setCachedAi("insights",r);setAiLoad("insights",false)});
  }

  function generatePlan() {
    if (isAiLoading("plan")) return;
    setAiLoad("plan", true);
    var ctx = getFinCtx();
    callAI(
      "Você é um planejador financeiro. Crie um plano otimizado para atingir as metas. Considere quitacao de dividas vs investimento. Seja específico com valores e prazos. Nunca use travessões dentro de parágrafos. Max 250 palavras. Português.",
      "Com estes dados, crie um plano otimizado para as metas:\n" + ctx
    ).then(function(r){setAiPlan(r);setAiLoad("plan",false)});
  }

  var LOCAL_CAT_PATTERNS = {
    c1: /sal[aá]rio|vencimento|remunera|proventos/i,
    c2: /aluguel|condom[ií]nio|iptu|energia|[aá]gua|g[aá]s|internet|celular/i,
    c3: /spotify|netflix|disney|hbo|prime|amazon prime|icloud|chatgpt|claude|streaming/i,
    c4: /faculdade|curso|escola|livro|tec concursos|estrat[eé]gia/i,
    c5: /mercado|supermercado|hortifruti|a[cç][oó]ugue|padaria|ifood|rappi/i,
    c6: /uber|99|gasolina|combustivel|estacionamento|pedagio|onibus/i,
    c7: /farmacia|remedio|ritalina|venvanse|medicamento|consulta|exame/i,
    c8: /parcela|acordo|emprestimo|financiamento/i,
    c9: /barbeiro|cabeleireiro|perfume|boticario|renner|reserva|dudalina|lacoste|levis/i,
    c10: /cinema|teatro|show|ingresso|bar|restaurante|lanche/i,
    c14: /amazon|shopee|mercado livre|aliexpress|magalu|presente|compra/i,
    c15: /anuidade|tarifa|taxa|iof/i,
    c16: /milhas|pontos|livelo|smiles|revpoints/i
  };
  function localCatMatch(desc) {
    var d = (desc || "").toLowerCase();
    var keys = Object.keys(LOCAL_CAT_PATTERNS);
    for (var i = 0; i < keys.length; i++) {
      if (LOCAL_CAT_PATTERNS[keys[i]].test(d)) return keys[i];
    }
    return "";
  }

    function suggestCat(desc) {
    if (!desc || desc.length < 3) { setAiCatSug(""); return; }
    var localMatch = localCatMatch(desc);
    if (localMatch) { setAiCatSug(localMatch); return; }
    // v14: Try local regex first
    var localCat = autoCategorize(desc);
    if (localCat) { setAiCatSug(localCat); return; }
    var catNames = (db.categorias||[]).filter(function(c){return c.tipo==="despesa"}).map(function(c){return c.id+":"+c.nome}).join(", ");
    callAI(
      "Responda APENAS com o ID da categoria mais provavel. Nada mais. Categorias: " + catNames,
      "Lançamento: " + desc
    ).then(function(r){
      var clean = r.trim().toLowerCase();
      var found = (db.categorias||[]).find(function(c){return clean.indexOf(c.id)>=0});
      setAiCatSug(found ? found.id : "");
    });
  }

  function simulateWhatIf() {
    if (!aiSimQ.trim() || aiLoading) return;
    setAiLoad("active", true);
    callAI(
      "Você é um simulador financeiro. Receba os dados reais e a pergunta 'E se...'. Calcule o impacto numerico na sobra mensal, prazo das metas, dividas e rating. Seja específico com valores. Nunca use travessões dentro de parágrafos. Max 250 palavras. Português.",
      "DADOS:\n" + getFinCtx() + "\n\nSIMULACAO: " + aiSimQ
    ).then(function(r){setAiSim(r);setAiLoad("active", false)});
  }

  function generateReport() {
    if (isAiLoading("report")) return;
    var cached = getCachedAi("report");
    if (cached) { setAiReport(cached); return; }
    setAiLoad("report", true);
    callAIStream(
      "Você é um consultor financeiro gerando um relatório mensal profissional. Estruture em: Resumo Executivo, Receitas e Despesas, Dívidas e Parcelas, Investimentos e Metas, Rating Bancário, Recomendações. Use dados específicos. Nunca use travessões dentro de parágrafos. Max 400 palavras. Português.",
      "Gere o relatório financeiro de " + MSF[mes-1] + "/" + ano + ":\n" + getFinCtx(),
      function(partial) { setAiReport(partial); }
    ).then(function(r){
      setAiReport(r);
      setCachedAi("report", r);
      setAiHistory(function(prev){ return [{mes:mes,ano:ano,date:new Date().toLocaleString("pt-BR"),text:r}].concat(prev).slice(0,12); });
      setAiLoad("report", false);
    });
  }

  function getRatingCoach() {
    if (isAiLoading("coach")) return;
    setAiLoad("coach", true);
    var hoje = new Date();
    var diaHoje = hoje.getDate();
    callAI(
      "Você é um coach especializado em rating bancário Santander Unlimited e Itaú The One. Gere 5 ações CONCRETAS para HOJE (dia " + diaHoje + "), considerando onde estamos no ciclo do mês: proximidade de fechamento, vencimento, salário, janela de pedido. Nunca use travessões dentro de parágrafos. Seja direto. Max 200 palavras. Português.",
      "DADOS ATUAIS:\n" + getFinCtx() + "\nDia de salario: " + (db.salarioDia||25) + "\nHoje: dia " + diaHoje + " de " + MSF[mes-1]
    ).then(function(r){setAiCoach(r);setAiLoad("active", false)});
  }

  function parseNaturalLanc() {
    if (!aiNlpInput.trim() || isAiLoading("nlp")) return;
    setAiLoad("nlp", true);
    var catList = (db.categorias||[]).map(function(c){return c.id+":"+c.nome+":"+c.tipo}).join(", ");
    var cardList = (db.cartoes||[]).map(function(c){return c.id+":"+c.nome}).join(", ");
    callAI(
      "Extraia dados de lançamento financeiro do texto. Responda APENAS com JSON puro (sem markdown, sem ```). Formato: {\"desc\":\"...\",\"valor\":0,\"tipo\":\"despesa|receita|parcela\",\"cat\":\"ID\",\"data\":\"YYYY-MM-DD\",\"status\":\"pago|pendente\",\"pg\":\"pix|cartao\",\"cartaoId\":\"\",\"pT\":0,\"pA\":1}. Categorias: " + catList + ". Cartoes: " + cardList + ". Hoje: " + hj() + ". Se não especificado: tipo=despesa, status=pendente, pg=pix, data=hoje.",
      aiNlpInput
    ).then(function(r){
      setAiLoad("active", false);
      try {
        var clean = r.replace(/```json/g,"").replace(/```/g,"").trim();
        var parsed = JSON.parse(clean);
        var ma = gMA(parsed.data || hj());
        setModal({type:"lanc",title:"IA: Confirmar lançamento",data:Object.assign({id:"",rec:false},parsed,{mes:ma.mes,ano:ma.ano,valor:parseBR(parsed.valor)})});
        setAiNlpInput("");
        flash("Lançamento criado pela IA! Confirme os dados.");
      } catch(e) { flash("Não consegui interpretar. Tente reformular."); }
    });
  }

  function detectAnomalies() {
    if (isAiLoading("anom")) return;
    setAiLoad("anom", true);
    var last3 = [];
    for (let off = -2; off <= 0; off++) {
      var ref = addMesRef(mes, ano, off);
      var mLancs = lancEx.filter(function(l){return l.mes===ref.mes && l.ano===ref.ano && l.tipo!=="receita"});
      var total = mLancs.reduce(function(s,l){return s+l.valor},0);
      var top = mLancs.sort(function(a,b){return b.valor-a.valor}).slice(0,8).map(function(l){return l.desc+":"+f$(l.valor)}).join(", ");
      last3.push(MS[ref.mes-1]+": total "+f$(total)+" | "+top);
    }
    callAI(
      "Você é um detector de anomalias financeiras. Compare os 3 meses e identifique: gastos que apareceram de repente, valores que subiram muito, categorias fora do padrao, despesas duplicadas suspeitas. Seja específico. Nunca use travessões dentro de parágrafos. Max 200 palavras. Português.",
      "ULTIMOS 3 MESES:\n" + last3.join("\n") + "\n\nDADOS COMPLETOS DO MES ATUAL:\n" + getFinCtx()
    ).then(function(r){setAiAnom(r);setAiLoad("active", false)});
  }

  function predictNextMonth() {
    if (isAiLoading("predict")) return;
    setAiLoad("predict", true);
    callAI(
      "Você é um previsor financeiro. Com base nos dados atuais (fixas, parcelas, receita recorrente, tendencias), projete o proximo mes: receita esperada, despesas fixas, parcelas (quais terminam, quais continuam), sobra estimada, eventos importantes. Nunca use travessões dentro de parágrafos. Seja específico com valores. Max 250 palavras. Português.",
      "DADOS DE " + MSF[mes-1] + ":\n" + getFinCtx()
    ).then(function(r){setAiPredict(r);setAiLoad("active", false)});
  }

  function suggestEconomy() {
    if (isAiLoading("econ")) return;
    setAiLoad("econ", true);
    callAI(
      "Você é um especialista em economia doméstica. Análise os gastos e sugira 5-7 cortes ou otimizações concretas, com o valor estimado de economia por mês. Priorize por impacto. Nunca use travessões dentro de parágrafos. Seja direto e prático. Max 250 palavras. Português.",
      "GASTOS ATUAIS:\n" + getFinCtx()
    ).then(function(r){setAiEcon(r);setAiLoad("active", false)});
  }

  function compareDebts() {
    if (isAiLoading("debtcmp")) return;
    setAiLoad("debtcmp", true);
    var divs = (db.dividas||[]).filter(function(d){return !d.quitada}).map(function(d){
      var rest = d.total - d.pago;
      return d.nome + ": total " + f$(d.total) + ", pago " + f$(d.pago) + ", restante " + f$(rest) + ", parcela " + f$(d.parcela) + "/mês, juros " + (d.juros||"desconhecido");
    }).join("\n");
    var parcs = (db.lancamentos||[]).filter(function(l){return l.tipo==="parcela" && l.pT>0}).reduce(function(acc,l){
      if (!acc[l.desc]) acc[l.desc] = {nome:l.desc,valor:l.valor,pT:l.pT,pA:l.pA};
      if (l.pA > acc[l.desc].pA) acc[l.desc] = {nome:l.desc,valor:l.valor,pT:l.pT,pA:l.pA};
      return acc;
    },{});
    var parcList = Object.keys(parcs).map(function(k){var p=parcs[k]; return p.nome+": "+f$(p.valor)+"/mês, "+p.pA+"/"+p.pT+" parcelas";}).join("\n");
    callAI(
      "Você é um estrategista de quitação de dívidas. Compare método avalanche (juros altos primeiro) vs bola de neve (menores primeiro). Análise cada dívida/parcelamento e recomende a ordem ideal de quitação. Calcule quanto o usuário economizaria em juros. Nunca use travessões dentro de parágrafos. Seja específico. Max 300 palavras. Português.",
      "DÍVIDAS ATIVAS:\n" + (divs || "Nenhuma dívida formal") + "\n\nPARCELAMENTOS:\n" + (parcList || "Nenhum parcelamento") + "\n\nSobra mensal estimada: " + f$(getPrevisão(db, mes, ano).sobra) + "\n\nDADOS GERAIS:\n" + getFinCtx()
    ).then(function(r){setAiDebtCmp(r);setAiLoad("active", false)});
  }

  function generateBudget() {
    if (isAiLoading("budget")) return;
    setAiLoad("budget", true);
    callAI(
      "Você é um orçamentista pessoal. Crie um orçamento mensal ideal baseado na renda real do usuario. Use a regra 50/30/20 adaptada a realidade do usuário (considerando dividas e metas). Para cada categoria de gasto, indique: valor ideal, valor atual, e ajuste necessário. Nunca use travessões dentro de parágrafos. Seja concreto com valores. Max 300 palavras. Português.",
      "DADOS FINANCEIROS:\n" + getFinCtx()
    ).then(function(r){setAiBudget(r);setAiLoad("active", false)});
  }

  function generateDiagnosis() {
    if (isAiLoading("diag")) return;
    setAiLoad("diag", true);
    callAI(
      "Você é um médico financeiro. Faça um diagnóstico completo da saúde financeira. Avalie de 0 a 100 cada pilar: 1) Liquidez (reserva de emergência), 2) Endividamento (relação dívida/renda), 3) Poupanca (taxa de poupança mensal), 4) Investimentos (diversificação e crescimento), 5) Proteção (seguros e previdência), 6) Planejamento (metas e organização). Dê uma NOTA GERAL de 0 a 100 e explique cada pilar em 1-2 frases. Nunca use travessões dentro de parágrafos. Português.",
      "DADOS:\n" + getFinCtx()
    ).then(function(r){setAiDiag(r);setAiLoad("active", false)});
  }

  function generateWeekly() {
    if (isAiLoading("weekly")) return;
    setAiLoad("weekly", true);
    var hoje = new Date();
    var diaHoje = hoje.getDate();
    var diaSemana = hoje.getDay();
    var inicioSemana = new Date(hoje);
    inicioSemana.setDate(diaHoje - diaSemana);
    var lancSemana = lancEx.filter(function(l) {
      if (l.mes !== mes || l.ano !== ano) return false;
      var d = parseInt(l.data.split("-")[2]) || 0;
      return d >= inicioSemana.getDate() && d <= diaHoje;
    });
    var gastoSemana = lancSemana.filter(function(l){return l.tipo!=="receita"}).reduce(function(s,l){return s+l.valor},0);
    var recSemana = lancSemana.filter(function(l){return l.tipo==="receita"}).reduce(function(s,l){return s+l.valor},0);
    var topSemana = lancSemana.filter(function(l){return l.tipo!=="receita"}).sort(function(a,b){return b.valor-a.valor}).slice(0,5).map(function(l){return l.desc+": "+f$(l.valor)}).join(", ");
    var proxVenc = (db.fixas||[]).concat((db.lancamentos||[]).filter(function(l){return l.tipo==="parcela"&&l.mes===mes&&l.ano===ano&&l.status==="pendente"})).filter(function(f){return (f.dia||15) > diaHoje && (f.dia||15) <= diaHoje+7}).map(function(f){return (f.nome||f.desc)+": "+f$(f.valor||0)+" dia "+(f.dia||15)}).join(", ");
    callAI(
      "Você é um assistente financeiro fazendo o resumo semanal. Análise a semana e faça: 1) Resumo da semana (total gasto, total recebido), 2) Top gastos da semana, 3) Próximos vencimentos nos proximos 7 dias, 4) Alerta se ritmo de gasto está acima do ideal para fechar o mês, 5) Dica rapida para a próxima semana. Nunca use travessões dentro de parágrafos. Max 200 palavras. Português.",
      "SEMANA (ultimos " + (diaSemana+1) + " dias):\nGastos: " + f$(gastoSemana) + "\nReceitas: " + f$(recSemana) + "\nTop gastos: " + (topSemana||"nenhum") + "\nPróximos vencimentos (7 dias): " + (proxVenc||"nenhum") + "\nDia do mes: " + diaHoje + "/" + MSF[mes-1] + "\n\nDADOS COMPLETOS:\n" + getFinCtx()
    ).then(function(r){setAiWeekly(r);setAiLoad("active", false)});
  }

  function generatePatrimonial() {
    if (isAiLoading("patrim")) return;
    setAiLoad("patrim", true);
    var pv = getPrevisão(db, mes, ano);
    var divAtivas = (db.dividas||[]).filter(function(d){return !d.quitada});
    var divInfo = divAtivas.map(function(d){
      var rest = d.total - d.pago;
      var mesesRest = d.parcela > 0 ? Math.ceil(rest / d.parcela) : 0;
      return d.nome + ": restam " + f$(rest) + ", " + f$(d.parcela) + "/mês, ~" + mesesRest + " meses";
    }).join("\n");
    var parcAtivas = (db.lancamentos||[]).filter(function(l){return l.tipo==="parcela"&&l.pT>0&&l.pA<l.pT});
    var parcInfo = parcAtivas.reduce(function(acc,l){
      if (!acc[l.desc]) acc[l.desc] = l;
      if (l.pA > acc[l.desc].pA) acc[l.desc] = l;
      return acc;
    },{});
    var parcList = Object.keys(parcInfo).map(function(k){var p=parcInfo[k]; return p.desc+": "+f$(p.valor)+"/mês, faltam "+(p.pT-p.pA)+" parcelas (~"+(p.pT-p.pA)+" meses)";}).join("\n");
    callAI(
      "Você é um planejador patrimonial de longo prazo. Projete os próximos 12 meses, mês a mês, considerando: renda fixa, despesas fixas, parcelas que terminam (liberam orçamento), dívidas sendo pagas, investimentos acumulando, e metas em progresso. Para cada mês mostre: patrimônio líquido projetado (investimentos - dívidas restantes), sobra acumulada, dívidas que se encerram, parcelas que terminam. No final, de o panorama geral: quando ficará livre de dívidas, quando atingirá cada meta, patrimônio estimado em 12 meses. Nunca use travessões dentro de parágrafos. Use números concretos. Max 400 palavras. Português.",
      "SITUAÇÃO ATUAL:\nSobra mensal: " + f$(pv.sobra) + "\nInvestimento fixo: " + f$(db.investimentoFixo||0) + "/mês\nPatrimônio atual (investimentos): " + f$(pat.inv) + "\n\nDÍVIDAS ATIVAS:\n" + (divInfo||"Nenhuma") + "\n\nPARCELAMENTOS ATIVOS:\n" + (parcList||"Nenhum") + "\n\nMETAS:\n" + (db.metas||[]).map(function(m){return m.nome+": "+f$(m.atual)+"/"+f$(m.valor)+" (aporte "+f$(m.aporte)+"/mês, prazo "+m.prazo+")"}).join("\n") + "\n\nDADOS COMPLETOS:\n" + getFinCtx()
    ).then(function(r){setAiPatrim(r);setAiLoad("active", false)});
  }

  function generateCarPlan() {
    if (isAiLoading("car")) return;
    setAiLoad("car", true);
    var pv = getPrevisão(db, mes, ano);
    var divAtivas = (db.dividas||[]).filter(function(d){return !d.quitada});
    var totalDivRest = divAtivas.reduce(function(s,d){return s+(d.total-d.pago)},0);
    var totalParcMes = divAtivas.reduce(function(s,d){return s+d.parcela},0);
    var parcAtivas = (db.lancamentos||[]).filter(function(l){return l.tipo==="parcela"&&l.pT>0&&l.pA<l.pT&&l.mes===mes&&l.ano===ano});
    var totalParcLanc = parcAtivas.reduce(function(s,l){return s+l.valor},0);
    callAI(
      "Você é um consultor especializado em compra de veículos no Brasil. O usuário quer comprar um carro. Com base nos dados financeiros reais, analise detalhadamente:\n\n1) VALOR IDEAL DO CARRO: Qual faixa de preço é compatível com a renda e patrimônio. Regra: parcela não deve ultrapassar 20% da renda líquida, e o carro não deve valer mais que 50% da renda anual.\n\n2) MELHOR MOMENTO: Considerando dividas ativas, parcelas terminando, e projeção de sobra, quando seria seguro comprar (mes/ano estimado).\n\n3) COMO COMPRAR: Compare financiamento bancário vs consórcio vs à vista. Calcule cenarios de entrada (20%, 30%, 50%) com parcelas em 36, 48 e 60 meses. Use taxa média de 1.5% a.m. para financiamento.\n\n4) PARCELA IDEAL: Valor máximo de parcela que nao compromete as metas e a saúde financeira, considerando as parcelas e dividas já existentes.\n\n5) SEGURO ESTIMADO: Calcule com base no valor do carro (media 5-8% do valor ao ano para perfil jovem).\n\n6) CUSTOS INDIRETOS MENSAIS: IPVA (parcele em 3x), licenciamento, combustível (estimativa 1.200km/mês), manutenção preventiva, estacionamento, lavagem, revisoes periodicas, depreciação anual estimada (15% no primeiro ano, 10% nos seguintes).\n\n7) IMPACTO TOTAL: Some parcela + seguro + custos indiretos e mostre o comprometimento real mensal. Compare com a sobra atual.\n\n8) RECOMENDAÇÃO FINAL: Comprar agora ou esperar? Qual estrategia seguir?\n\nNunca use travessões dentro de parágrafos. Seja extremamente específico com valores em reais. Max 500 palavras. Português.",
      "SITUAÇÃO FINANCEIRA:\nRenda mensal: " + f$(pv.recTotal) + "\nDespesas totais: " + f$(pv.despTotal) + "\nSobra mensal: " + f$(pv.sobra) + "\nInvestimento fixo: " + f$(db.investimentoFixo||0) + "/mês\nPatrimônio (investimentos): " + f$(pat.inv) + "\nDívidas restantes: " + f$(totalDivRest) + " (parcelas: " + f$(totalParcMes) + "/mês)\nParcelamentos mensais: " + f$(totalParcLanc) + "\nComprometimento atual com parcelas+dívidas: " + f$(totalParcMes+totalParcLanc) + "/mês\n\nDÍVIDAS DETALHADAS:\n" + divAtivas.map(function(d){return d.nome+": restam "+f$(d.total-d.pago)+", "+f$(d.parcela)+"/mês"}).join("\n") + "\n\nMETAS:\n" + (db.metas||[]).map(function(m){return m.nome+": "+f$(m.atual)+"/"+f$(m.valor)}).join("\n") + "\n\nDADOS COMPLETOS:\n" + getFinCtx()
    ).then(function(r){setAiCar(r);setAiLoad("active", false)});
  }

  function generateBankMeeting() {
    if (isAiLoading("bankmeet")) return;
    setAiLoad("bankmeet", true);
    var pv = getPrevisão(db, mes, ano);
    var cartoes = (db.cartoes||[]).map(function(c){return c.nome+": limite "+f$(c.limite)+", fatura media "+f$(c.faturaMedia||0)}).join("\n");
    callAI(
      "Você é um assessor financeiro preparando o cliente para uma reunião com o gerente do banco. O objetivo é conseguir upgrade para Santander Unlimited e/ou Itaú The One. Crie um SCRIPT de reunião completo:\n\n1) ABERTURA: Como iniciar a conversa (frase exata para dizer ao gerente).\n2) ARGUMENTOS DE MOVIMENTACAO: Destaque valores reais de receita, saldo médio, volume de transações, tempo de relacionamento. Enfatize pontos fortes.\n3) PEDIDO ESPECÍFICO: O que pedir exatamente (cartao, limite, isenção de anuidade, benefícios). Frase exata.\n4) CONTRA-ARGUMENTOS: Se o gerente disser 'você não tem perfil ainda', como responder. Se pedir mais movimentação, o que prometer de concreto.\n5) NEGOCIAÇÃO DE ANUIDADE: Estratégia para pedir isenção ou desconto na anuidade. Mencionar concorrência.\n6) TIMING: Melhor dia e horário para ir ao banco. Melhor época do ano.\n7) PLANO B: Se negar, o que fazer nos próximos 3 meses para voltar e conseguir.\n\nNunca use travessões dentro de parágrafos. Seja prático com frases prontas para usar. Max 400 palavras. Português.",
      "PERFIL FINANCEIRO DO CLIENTE:\nRenda: " + f$(pv.recTotal) + "/mês\nSobra: " + f$(pv.sobra) + "/mês\nInvestimentos: " + f$(pat.inv) + "\nCartões atuais:\n" + cartoes + "\nScore rating: " + ratingScore + "/100\n\nDADOS COMPLETOS:\n" + getFinCtx()
    ).then(function(r){setAiBankMeet(r);setAiLoad("active", false)});
  }

  function analyzeAll() {
    if (aiLoading) return;
    var ctx = getFinCtx();
    var hoje = new Date();
    var diaHoje = hoje.getDate();
    setAiAllProg(1);
    setAiLoad("active", true);

    callAI("Você é um assistente financeiro fazendo o resumo semanal. Análise gastos da semana, próximos vencimentos, ritmo de gasto vs orçamento, dica rápida. Nunca use travessões dentro de parágrafos. Max 200 palavras. Português.", "Dia do mes: "+diaHoje+"\n"+ctx)
    .then(function(r){ setAiWeekly(r); setAiAllProg(2);
      return callAI("Você é um analista financeiro. Gere 4-5 insights curtos e acionaveis. Cada insight em uma linha. Use dados específicos. Nunca use travessões dentro de parágrafos. Português.", "Análise:\n"+ctx);
    }).then(function(r){ setAiInsights(r); setAiAllProg(3);
      return callAI("Você é um coach especializado em rating bancário Santander Unlimited e Itaú The One. Gere 5 ações CONCRETAS para HOJE (dia "+diaHoje+"). Nunca use travessões dentro de parágrafos. Max 200 palavras. Português.", "DADOS:\n"+ctx+"\nDia salario: "+(db.salarioDia||25)+"\nHoje: dia "+diaHoje);
    }).then(function(r){ setAiCoach(r); setAiAllProg(4);
      return callAI("Você é um planejador financeiro. Crie um plano otimizado para atingir as metas. Considere quitacao vs investimento. Nunca use travessões dentro de parágrafos. Max 250 palavras. Português.", "Plano para metas:\n"+ctx);
    }).then(function(r){ setAiPlan(r); setAiAllProg(5);
      return callAI("Você é um previsor financeiro. Projete o proximo mes: receita, despesas fixas, parcelas que terminam/continuam, sobra estimada. Nunca use travessões dentro de parágrafos. Max 250 palavras. Português.", "DADOS DE "+MSF[mes-1]+":\n"+ctx);
    }).then(function(r){ setAiPredict(r); setAiAllProg(6);
      return callAI("Você é um detector de anomalias. Identifique gastos fora do padrao, valores que subiram, duplicados suspeitos. Nunca use travessões dentro de parágrafos. Max 200 palavras. Português.", "DADOS:\n"+ctx);
    }).then(function(r){ setAiAnom(r); setAiAllProg(7);
      return callAI("Você é um especialista em economia doméstica. Sugira 5-7 cortes concretos com valor estimado de economia/mes. Nunca use travessões dentro de parágrafos. Max 250 palavras. Português.", "GASTOS:\n"+ctx);
    }).then(function(r){ setAiEcon(r); setAiAllProg(8);
      return callAI("Você é um médico financeiro. Diagnostico completo: avalie de 0 a 100 cada pilar (liquidez, endividamento, poupanca, investimentos, protecao, planejamento). NOTA GERAL 0-100. Nunca use travessões dentro de parágrafos. Português.", "DADOS:\n"+ctx);
    }).then(function(r){ setAiDiag(r); setAiAllProg(9);
      return callAI("Você é um consultor financeiro gerando relatório mensal profissional. Estruture em: Resumo Executivo, Receitas e Despesas, Dívidas e Parcelas, Investimentos e Metas, Rating Bancário, Recomendações. Nunca use travessões dentro de parágrafos. Max 400 palavras. Português.", "Relatório de "+MSF[mes-1]+"/"+ano+":\n"+ctx);
    }).then(function(r){ setAiReport(r); setAiAllProg(0); setAiLoad("active", false); flash("9 analises concluidas!"); })
    ["catch"](function(e){ setAiAllProg(0); setAiLoad("active", false); flash("Erro na analise: "+e.message); });
  }

  function togglePago(l) {
    var novoStatus = l.status === "pago" ? "pendente" : "pago";
    sv(Object.assign({}, db, {lancamentos: (db.lancamentos||[]).map(function(x){
      return x.id === l.id ? Object.assign({}, x, {status: novoStatus}) : x;
    })}));
    flash(novoStatus === "pago" ? "Marcado como pago!" : "Revertido para pendente");
    setSwipeId("");
  }

  function detectRecurring() {
    if (aiLoading) return;
    setAiLoad("active", true);
    var last3 = [];
    for (let off = -2; off <= 0; off++) {
      var ref = addMesRef(mes, ano, off);
      var mLancs = (db.lancamentos||[]).filter(function(l){return l.mes===ref.mes && l.ano===ref.ano}).map(function(l){return l.desc+"|"+l.valor+"|"+l.tipo}).join("; ");
      last3.push(MSF[ref.mes-1] + ": " + mLancs);
    }
    var fixasAtuais = (db.fixas||[]).map(function(f){return f.nome+": "+f$(f.valor)}).join(", ");
    callAI(
      "Você é um detector de padroes financeiros. Análise os lancamentos dos ultimos 3 meses e identifique despesas que se repetem (mesma descricao ou similar, valores iguais ou proximos) e que NAO estao nas despesas fixas. Liste cada despesa recorrente detectada com: nome, valor médio, frequencia, e sugira se deve ser adicionada como fixa. Nunca use travessões dentro de parágrafos. Max 250 palavras. Português.",
      "LANCAMENTOS 3 MESES:\n" + last3.join("\n") + "\n\nDESPESAS FIXAS JA CADASTRADAS:\n" + (fixasAtuais || "Nenhuma") + "\n\nDADOS:\n" + getFinCtx()
    ).then(function(r){setAiRecur(r);setAiLoad("active", false)});
  }

  function getNotifications() {
    var hoje = new Date();
    var diaHoje = hoje.getDate();
    var diaSal = db.salarioDia || 25;
    var diasSal = diaSal > diaHoje ? diaSal - diaHoje : (diaSal < diaHoje ? (30 - diaHoje + diaSal) : 0);
    var notifs = [];
    if (diasSal <= 5 && diasSal > 0) notifs.push({icon:DollarSign, text:"Salario em " + diasSal + " dia" + (diasSal>1?"s":""), cor:T.green, dias:diasSal});
    if (diasSal === 0) notifs.push({icon:DollarSign, text:"Dia de salario!", cor:T.green, dias:0});
    var cards = Array.isArray(db.cartoes) ? db.cartoes : [];
    cards.forEach(function(c) {
      var vDia = c.venc || 10;
      var diasVenc = vDia > diaHoje ? vDia - diaHoje : -1;
      if (diasVenc >= 0 && diasVenc <= 5) {
        var meta = (db.faturasManuais || {})[c.id + "|" + String(ano).padStart(4,"0") + "-" + String(mes).padStart(2,"0")] || {};
        if (!meta.paga) notifs.push({icon:CreditCard, text:"Fatura " + c.nome + (diasVenc===0 ? " vence HOJE!" : " vence em " + diasVenc + " dia" + (diasVenc>1?"s":"")), cor:diasVenc<=1?T.red:T.gold, dias:diasVenc});
      }
    });
    (db.fixas || []).forEach(function(f) {
      var fDia = f.dia || 15;
      var diasF = fDia > diaHoje ? fDia - diaHoje : -1;
      if (diasF >= 0 && diasF <= 3) {
        var chave = mes + "-" + ano;
        if (!(db.fixasPagas && db.fixasPagas[chave] && db.fixasPagas[chave][f.id])) notifs.push({icon:Bell, text:f.nome + (diasF===0 ? " vence HOJE!" : " em " + diasF + " dia" + (diasF>1?"s":"")), cor:diasF<=0?T.red:T.amber, dias:diasF});
      }
    });
    return notifs.sort(function(a,b){return a.dias - b.dias});
  }

  function exportReportPDF() {
    var report = aiReport;
    if (!report) { flash("Gere o relatório na aba IA primeiro"); return; }
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Relatório ' + MSF[mes-1] + ' ' + ano + '</title><style>body{font-family:Inter,Arial,sans-serif;max-width:700px;margin:40px auto;padding:20px;color:#1a1a2e;line-height:1.7;font-size:13px}h1{color:#0088DD;border-bottom:3px solid #0088DD;padding-bottom:12px;font-size:22px}h2{color:#00B864;font-size:16px;margin-top:24px}.meta{color:#666;font-size:12px;margin-bottom:20px}.content{white-space:pre-wrap;background:#f8f9fc;padding:20px;border-radius:12px;border:1px solid #e0e4ec}.footer{margin-top:30px;text-align:center;color:#999;font-size:12px;border-top:1px solid #eee;padding-top:12px}</style></head><body>';
    html += '<h1>COJUR Vault</h1>';
    html += '<div class="meta">Relatório de ' + MSF[mes-1] + ' ' + ano + ' | Gerado em ' + new Date().toLocaleDateString("pt-BR") + '</div>';
    html += '<h2>Resumo financeiro</h2>';
    html += '<div class="content">' + report.replace(/</g,"&lt;").replace(/>/g,"&gt;") + '</div>';
    html += '<div class="footer">COJUR Vault v' + VER + '</div>';
    html += '</body></html>';
    var blob = new Blob([html], {type:"text/html"});
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "relatório-" + MSF[mes-1].toLowerCase() + "-" + ano + ".html";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){URL.revokeObjectURL(url);try{document.body.removeChild(a)}catch(e){}},300);
    flash("Relatório exportado!");
  }

  function distribuirAporte() {
    var metasAtivas = (db.metas||[]).filter(function(m){return (m.atual||0)<m.valor});
    var totalAp = metasAtivas.reduce(function(s,x){return s+(x.aporte||0)},0);
    var disp = Math.max(0, (getPrevisão(db,mes,ano).sobra||0) - (db.investimentoFixo||0));
    if (disp <= 0 || totalAp <= 0) { flash("Sem sobra disponivel para aportes"); setShowAporteModal(false); return; }
    var novasMetas = (db.metas||[]).map(function(m) {
      if ((m.atual||0) >= m.valor) return m;
      var val = Math.round(disp * (m.aporte||0) / totalAp * 100) / 100;
      var novoAtual = Math.min(m.valor, (m.atual||0) + val);
      return Object.assign({}, m, {atual: novoAtual});
    });
    sv(Object.assign({}, db, {metas: novasMetas}));
    flash("Aportes distribuidos nas metas!");
    setShowAporteModal(false);
  }

  function exportPDF() {
    var pv = getPrevisão(db, mes, ano);
    var p = getPat(db);
    var divAtivas = (db.dividas||[]).filter(function(d){return !d.quitada});
    var topDesp = lancEx.filter(function(l){return l.mes===mes&&l.ano===ano&&l.tipo!=="receita"}).sort(function(a,b){return b.valor-a.valor}).slice(0,10);
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Relatório Financeiro '+MSF[mes-1]+'/'+ano+'</title><style>body{font-family:Inter,Arial,sans-serif;max-width:800px;margin:0 auto;padding:40px;color:#1a1a2e;font-size:13px}h1{color:#0055A4;border-bottom:3px solid #00E5FF;padding-bottom:10px}h2{color:#333;margin-top:30px;border-left:4px solid #00E5FF;padding-left:12px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #eee}th{background:#f4f6fa;font-weight:700}td.num{text-align:right;font-family:monospace;font-weight:600}.green{color:#00B864}.red{color:#E02040}.gold{color:#E6A800}.footer{margin-top:40px;padding-top:16px;border-top:2px solid #eee;font-size:12px;color:#999;text-align:center}</style></head><body>';
    html += '<h1>Relatório Financeiro: '+MSF[mes-1]+' '+ano+'</h1>';
    html += '<h2>Resumo do Mes</h2><table><tr><td>Receita total</td><td class="num green">'+f$(pv.recTotal)+'</td></tr><tr><td>Despesas totais</td><td class="num red">'+f$(pv.despTotal)+'</td></tr><tr><td>Sobra</td><td class="num '+(pv.sobra>=0?'green':'red')+'">'+f$(pv.sobra)+'</td></tr></table>';
    html += '<h2>Patrimônio</h2><table><tr><td>Saldo em contas</td><td class="num">'+f$(p.sc)+'</td></tr><tr><td>Investimentos</td><td class="num green">'+f$(p.inv)+'</td></tr><tr><td>Dívidas</td><td class="num red">'+f$(p.dv)+'</td></tr><tr><td>Patrimônio líquido</td><td class="num '+(p.liq>=0?'green':'red')+'"><strong>'+f$(p.liq)+'</strong></td></tr></table>';
    if (divAtivas.length > 0) {
      html += '<h2>Dívidas Ativas</h2><table><tr><th>Nome</th><th>Restante</th><th>Parcela</th><th>Meses</th></tr>';
      divAtivas.forEach(function(d){var rest=d.total-d.pago;var mR=d.parcela>0?Math.ceil(rest/d.parcela):0;html+='<tr><td>'+d.nome+'</td><td class="num red">'+f$(rest)+'</td><td class="num">'+f$(d.parcela)+'</td><td class="num">'+mR+'</td></tr>';});
      html += '</table>';
    }
    html += '<h2>Top 10 Despesas</h2><table><tr><th>Descricao</th><th>Valor</th><th>Status</th></tr>';
    topDesp.forEach(function(l){html+='<tr><td>'+l.desc+'</td><td class="num red">'+f$(l.valor)+'</td><td>'+l.status+'</td></tr>';});
    html += '</table>';
    if (db.metas && db.metas.length > 0) {
      html += '<h2>Metas</h2><table><tr><th>Meta</th><th>Atual</th><th>Alvo</th><th>Progresso</th></tr>';
      (db.metas||[]).forEach(function(m){var pr=m.valor>0?Math.round(m.atual/m.valor*100):0;html+='<tr><td>'+m.nome+'</td><td class="num">'+f$(m.atual)+'</td><td class="num">'+f$(m.valor)+'</td><td class="num '+(pr>=100?'green':'gold')+'">'+pr+'%</td></tr>';});
      html += '</table>';
    }
    html += '<h2>Rating Bancário</h2><table><tr><td>Score geral</td><td class="num"><strong>'+ratingScore+'/100</strong></td></tr><tr><td>Saúde financeira</td><td class="num">'+healthScore+'/100</td></tr></table>';
    if (aiReport) { html += '<h2>Análise IA</h2><div style="white-space:pre-wrap;line-height:1.7;background:#f9fafb;padding:16px;border-radius:8px;border:1px solid #eee">'+aiReport.replace(/</g,"&lt;").replace(/>/g,"&gt;")+'</div>'; }
    html += '<div class="footer">COJUR Vault v'+VER+' | Gerado em '+new Date().toLocaleDateString("pt-BR")+" "+new Date().toLocaleTimeString("pt-BR")+'</div></body></html>';
    var blob = new Blob([html], {type:"text/html"});
    var url = URL.createObjectURL(blob);
    var w = window.open(url, "_blank");
    if (w) { setTimeout(function(){ w.print(); },800); }
    else { flash("Popup bloqueado. Permita popups para gerar PDF."); }
    setTimeout(function(){URL.revokeObjectURL(url)},5000);
  }

  function getCalendarData() {
    var days = [];
    var daysInMonth = new Date(ano, mes, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      var ds = ano + "-" + String(mes).padStart(2,"0") + "-" + String(d).padStart(2,"0");
      var dayLancs = (db.lancamentos||[]).filter(function(l){return l.mes===mes && l.ano===ano && l.data && l.data.slice(8,10) === String(d).padStart(2,"0")});
      var rec = dayLancs.filter(function(l){return l.tipo==="receita"}).reduce(function(s,l){return s+l.valor},0);
      var desp = dayLancs.filter(function(l){return l.tipo!=="receita"}).reduce(function(s,l){return s+l.valor},0);
      var hasFixa = (db.fixas||[]).some(function(f){return (f.dia||15)===d});
      var hasFat = (db.cartoes||[]).some(function(c){return (c.venc||10)===d});
      days.push({d:d, ds:ds, rec:rec, desp:desp, lancs:dayLancs, hasFixa:hasFixa, hasFat:hasFat, total:dayLancs.length});
    }
    return days;
  }

  function getComparativo3m() {
    var data = [];
    for (let i = -2; i <= 0; i++) {
      var ref = addMesRef(mes, ano, i);
      var pvi = getPrevisão(db, ref.mes, ref.ano);
      var divPagas = (db.dividas||[]).reduce(function(s,d){return s + (d.pago||0)},0);
      data.push({
        nome: MS[ref.mes-1],
        mes: ref.mes, ano: ref.ano,
        receita: pvi.receitaMes||0,
        despesa: pvi.despLancadas||0,
        sobra: pvi.sobra||0,
        investido: db.investimentoFixo||0
      });
    }
    return data;
  }

  function getConsistencyScore() {
    var hoje = new Date();
    var diaHoje = hoje.getDate();
    var diasComLanc = {};
    (db.lancamentos||[]).forEach(function(l) {
      if (l.mes === mes && l.ano === ano && !l.virtual && !l.rec) {
        var dia = parseInt((l.data||"").slice(8,10)) || 0;
        if (dia > 0) diasComLanc[dia] = true;
      }
    });
    var diasAtivos = Object.keys(diasComLanc).length;
    var diasPassados = Math.min(diaHoje, new Date(ano, mes, 0).getDate());
    var score = diasPassados > 0 ? Math.round(diasAtivos / diasPassados * 100) : 0;
    var ultimoDia = 0;
    Object.keys(diasComLanc).forEach(function(d){var n=parseInt(d);if(n>ultimoDia)ultimoDia=n;});
    var diasSemLanc = diaHoje - ultimoDia;
    return {score:score, diasAtivos:diasAtivos, diasPassados:diasPassados, diasSemLanc:diasSemLanc, ultimoDia:ultimoDia};
  }

  function quickEntry() {
    if (!quickInput.trim() || aiLoading) return;
    setAiLoad("active", true);
    var catList = (db.categorias||[]).map(function(c){return c.id+":"+c.nome+":"+c.tipo}).join(", ");
    var cardList = (db.cartoes||[]).map(function(c){return c.id+":"+c.nome}).join(", ");
    callAI(
      "Extraia dados de lançamento financeiro do texto. Responda APENAS com JSON puro (sem markdown). Formato: {\"desc\":\"...\",\"valor\":0,\"tipo\":\"despesa|receita\",\"cat\":\"ID\",\"data\":\"YYYY-MM-DD\",\"status\":\"pago\",\"pg\":\"pix|cartao\",\"cartaoId\":\"\"}. Categorias: " + catList + ". Cartoes: " + cardList + ". Hoje: " + hj() + ". Se não especificado: tipo=despesa, status=pago, pg=pix, data=hoje.",
      quickInput
    ).then(function(r){
      setAiLoad("active", false);
      try {
        var clean = r.replace(/```json/g,"").replace(/```/g,"").trim();
        var parsed = JSON.parse(clean);
        var ma = gMA(parsed.data || hj());
        var l = {
          id: uid(), data: parsed.data || hj(), mes: ma.mes, ano: ma.ano,
          tipo: parsed.tipo || "despesa", cat: parsed.cat || "c6",
          desc: parsed.desc || quickInput, valor: parseBR(parsed.valor) || 0,
          status: parsed.status || "pago", cartaoId: parsed.cartaoId || "",
          pg: parsed.pg || "pix", rec: false, pT: 0, pA: 0, totalCompra: 0
        };
        sv(Object.assign({}, db, {lancamentos: (db.lancamentos||[]).concat([l])}));
        flash(l.desc + " " + f$(l.valor) + " adicionado!");
        setQuickInput("");
        setQuickShow(false);
      } catch(e) { flash("Não entendi. Tente: '50 uber pix'"); }
    });
  }

  var consistency = getConsistencyScore();
  var comp3m = getComparativo3m();
  var calData = getCalendarData();

  function handleExportCSV() {
    try {
      var header = "Data,Tipo,Categoria,Descricao,Valor,Status,Forma Pgto,Cartao,Recorrente,Parcela Atual,Parcela Total\n";
      var rows = (db.lancamentos || []).map(function(l) {
        return [l.data, l.tipo, catN(l.cat), '"' + (l.desc||"").replace(/"/g,"'") + '"', l.valor, l.status, l.pg || "pix", l.cartaoId || "", l.rec ? "Sim" : "Nao", l.pA || 0, l.pT || 0].join(",");
      }).join("\n");
      var csv = header + rows;
      var blob = new Blob(["\uFEFF" + csv], {type:"text/csv;charset=utf-8"});
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "lancamentos-" + hj() + ".csv"; a.style.display = "none";
      document.body.appendChild(a); a.click();
      setTimeout(function(){URL.revokeObjectURL(url);try{document.body.removeChild(a)}catch(e){}},300);
      flash("CSV exportado!");
    } catch(e) { flash("Erro ao exportar CSV"); }
  }

    function handleExport() {
    try {
      var json = JSON.stringify(db, null, 2);
      var blob = new Blob([json], {type: "application/json"});
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "financas-" + hj() + ".json";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function() { URL.revokeObjectURL(url); try { document.body.removeChild(a); } catch(e) {} }, 300);
      flash("Arquivo exportado!");
    } catch (e) {
      flash("Erro ao exportar");
    }
  }

  function prevMes() { if(mes===1){setMes(12);setAno(ano-1)} else setMes(mes-1); }
  function nextMes() { if(mes===12){setMes(1);setAno(ano+1)} else setMes(mes+1); }

  
  var lancEx = useMemo(function(){return expandLançamentos(db)}, [db]);
  var dbEx = useMemo(function(){return Object.assign({}, db, {lancamentos: lancEx})}, [db, lancEx]);

  var res = useMemo(function(){return getRes(dbEx,mes,ano)}, [dbEx,mes,ano]);
  var pat = useMemo(function(){return getPat(db)}, [db]);
  var pv = useMemo(function(){return getPrevisão(dbEx,mes,ano)}, [dbEx,mes,ano]);
  var assin = useMemo(function(){return lancEx.filter(function(l){return l.mes===mes&&l.ano===ano&&(l.cat==="c3"||l.cat==="c15"||(l.cat==="c16"&&l.rec))})}, [lancEx,mes,ano]);
  var fixas = useMemo(function(){return lancEx.filter(function(l){return l.mes===mes&&l.ano===ano&&l.rec&&l.tipo!=="receita"})}, [lancEx,mes,ano]);
  var parcelas = useMemo(function(){return lancEx.filter(function(l){return l.mes===mes&&l.ano===ano&&(l.tipo==="parcela"||l.pT>0)})}, [lancEx,mes,ano]);
  var metP = useMemo(function(){return getMetP(db)}, [db]);
  var als = useMemo(function(){return getAl(dbEx,mes,ano)}, [dbEx,mes,ano]);
  var fluxo = useMemo(function(){return getFluxoFinanceiro(dbEx,mes,ano)}, [dbEx,mes,ano]);
  var cardsResumo = useMemo(function(){return getCardsResumo(dbEx,mes,ano)}, [dbEx,mes,ano]);
  var proxSal = useMemo(function(){return getProxSalarioInfo(dbEx,mes,ano,db.salarioDia||25)}, [dbEx,mes,ano,db.salarioDia]);
  var ratingTasks = useMemo(function(){return getRatingTasks()}, []);
  var ratingDonts = useMemo(function(){return getRatingDonts()}, []);
  var ratingKey = ano + "-" + (mes<10?"0":"") + mes;
  var ratingMes = (db.ratingMensal && db.ratingMensal[ratingKey]) || {};
  var visAnual = useMemo(function(){return getVisaoAnual(dbEx,ano)}, [dbEx,ano]);

  // === v15: Signature moment - celebra quando bater meta ===
  useEffect(function(){
    var metasAtingidas = (db.metas||[]).filter(function(m){ return m.valor > 0 && (m.atual||0) >= m.valor; });
    if (metasAtingidas.length > 0) {
      var chave = metasAtingidas.map(function(m){ return m.id; }).join(",");
      if (chave && chave !== lastCelebrated) {
        setLastCelebrated(chave);
        // Pequeno delay para user ver o contexto antes da celebração
        setTimeout(function(){ fireConfetti(); }, 300);
      }
    }
  }, [db.metas]);

  var faturaAlertCount = useMemo(function() {
    var count = 0;
    var hoje = new Date();
    cardsResumo.forEach(function(c) {
      if (c.faturas && c.faturas[0] && !c.faturas[0].paga) {
        var venc = c.faturas[0].vencDate;
        var diff = (venc - hoje) / (1000 * 60 * 60 * 24);
        if (diff <= 3 && diff >= -7) count++;
      }
    });
    return count;
  }, [cardsResumo]);

    var notifs = getNotifications();
  // v14: Count faturas vencendo em 3 dias
  function getSparkData(prop) {
    var data = [];
    for (let i = -2; i <= 0; i++) {
      var ref = addMesRef(mes, ano, i);
      var pvi = getPrevisão(db, ref.mes, ref.ano);
      data.push({m:MS[ref.mes-1], v:pvi[prop]||0});
    }
    return data;
  }

  function catN(id) { var c = (db.categorias||[]).find(function(x){return x.id===id}); return c ? c.nome : id; }
  function catInfo(id) { var c = (db.categorias||[]).find(function(x){return x.id===id}); var def = CATS.find(function(x){return x.id===id}); return {nome:c?c.nome:id, emoji:c&&c.emoji?c.emoji:(def?def.emoji:"📦"), cor:c&&c.cor?c.cor:(def?def.cor:"#6B7280")}; }

  function updCatOrc(id, v) {
    sv(Object.assign({}, db, {categorias: (db.categorias||[]).map(function(c){
      return c.id===id ? Object.assign({},c,{orc:v}) : c;
    })}));
    flash("Orçamento atualizado!");
  }

  function updInvestFixo(v) {
    sv(Object.assign({}, db, {investimentoFixo: v}));
    flash("Investimento fixo atualizado!");
  }

  function updSalarioDia(v) {
    var dia = Math.max(1, Math.min(31, parseInt(v) || 25));
    sv(Object.assign({}, db, {salarioDia: dia}));
    flash("Dia do salario atualizado para " + dia + "!");
  }

  var totalAssin = assin.reduce(function(s,l){return s+l.valor},0);
  var totalFixas = fixas.reduce(function(s,l){return s+l.valor},0);
  var sobraFixas = res.rc - totalFixas;
  var debtProjections = useMemo(function(){return getDebtPayoffProjection(db.dividas, parcelas)}, [db.dividas, parcelas]);
  var totalParcMes = parcelas.reduce(function(s,l){return s+l.valor},0);
  var rentTotal = (db.investimentos||[]).reduce(function(s,i){return s+i.valor*(i.rent/100)},0);
  var frase = FRASES[Math.floor(Date.now()/86400000) % FRASES.length];
  var fraseParc = FRASES_PARC[Math.floor(Date.now()/86400000) % FRASES_PARC.length];
  var totalLimites = cardsResumo.reduce(function(s,c){return s + (c.limite||0)},0);
  var totalFaturaAtual = cardsResumo.reduce(function(s,c){return s + (c.faturaAtual||0)},0);
  var totalProxFatura = cardsResumo.reduce(function(s,c){return s + (c.proxFatura||0)},0);
  var totalSegundaFatura = cardsResumo.reduce(function(s,c){return s + (c.segundaFatura||0)},0);
  var totalComprometidoCartoes = cardsResumo.reduce(function(s,c){return s + (c.comprometido||0)},0);
  var totalLivreReal = cardsResumo.reduce(function(s,c){return s + (c.livreReal||0)},0);
  var usoTotalCartoes = totalLimites > 0 ? (cardsResumo.reduce(function(s,c){return s + (c.gastosMes||0)},0)/totalLimites)*100 : 0;
  var usoRealCartoes = totalLimites > 0 ? (totalComprometidoCartoes/totalLimites)*100 : 0;
  var ratingAtual = useMemo(function(){return getRatingSnapshot(dbEx, mes, ano, db.salarioDia||25, db.ratingMensal)}, [dbEx, mes, ano, db.salarioDia, db.ratingMensal]);
  var refRatingAnt = addMesRef(mes, ano, -1);
  var ratingAnterior = useMemo(function(){return getRatingSnapshot(dbEx, refRatingAnt.mes, refRatingAnt.ano, db.salarioDia||25, db.ratingMensal)}, [dbEx, refRatingAnt.mes, refRatingAnt.ano, db.salarioDia, db.ratingMensal]);
  var ratingChecklist = ratingAtual.checklist;
  var ratingAuto = ratingAtual.auto;
  var ratingScore = ratingAtual.score;
  var ratingColor = ratingAtual.color;
  var ratingDelta = ratingScore - ratingAnterior.score;
  var ratingDeltaColor = ratingDelta >= 0 ? T.green : T.red;
  var ratingResumoMotivos = ratingAtual.motivos.filter(function(m){ return m.tipo !== "ok"; });
  var calendarioFinanceiro = useMemo(function(){return getCalendarioFinanceiro(db, mes, ano, db.salarioDia||25)}, [db, mes, ano, db.salarioDia]);
  var planoSantander = useMemo(function(){return getBankPlan(dbEx, mes, ano, "santander", db.salarioDia||25, db.ratingMensal)}, [dbEx, mes, ano, db.salarioDia, db.ratingMensal]);
  var planoItau = useMemo(function(){return getBankPlan(dbEx, mes, ano, "itau", db.salarioDia||25, db.ratingMensal)}, [dbEx, mes, ano, db.salarioDia, db.ratingMensal]);
  var refPlanoAnt = addMesRef(mes, ano, -1);
  var planoSantanderAnt = useMemo(function(){return getBankPlan(dbEx, refPlanoAnt.mes, refPlanoAnt.ano, "santander", db.salarioDia||25, db.ratingMensal)}, [dbEx, refPlanoAnt.mes, refPlanoAnt.ano, db.salarioDia, db.ratingMensal]);
  var planoItauAnt = useMemo(function(){return getBankPlan(dbEx, refPlanoAnt.mes, refPlanoAnt.ano, "itau", db.salarioDia||25, db.ratingMensal)}, [dbEx, refPlanoAnt.mes, refPlanoAnt.ano, db.salarioDia, db.ratingMensal]);
  var bancoFocoManual = ratingMes._bancoFoco || "";
  var focoEstrategico = useMemo(function(){return getStrategicFocus(planoSantander, planoItau, fluxo, als, cardsResumo, bancoFocoManual)}, [planoSantander, planoItau, fluxo, als, cardsResumo, bancoFocoManual]);
  var pvAnt = useMemo(function(){var ref = addMesRef(mes, ano, -1); return getPrevisão(dbEx, ref.mes, ref.ano);}, [dbEx, mes, ano]);
  var deltaReceita = pv.receitaMes - pvAnt.receitaMes;
  var deltaDespesas = pv.despLancadas - pvAnt.despLancadas;
  var deltaSobra = pv.sobraPrevista - pvAnt.sobraPrevista;
  var checklistGeral = useMemo(function(){return getChecklistGeral(fluxo, cardsResumo, als)}, [fluxo, cardsResumo, als]);
  var weeklyTasks = useMemo(function(){return getWeeklyChecklist()}, []);
  var weekKey = getWeekKey();
  var checklistSemanal = weeklyTasks.map(function(t) {
    var wkField = "_" + weekKey + "_" + t.id;
    var ok = !!(ratingMes[wkField]);
    return {id:t.id, label:t.titulo, detail:t.desc, ok:ok, wkField:wkField};
  });

  function togWeeklyTask(taskId) {
    var chave = ano + "-" + (mes<10?"0":"") + mes;
    var wkField = "_" + weekKey + "_" + taskId;
    var rm = Object.assign({}, db.ratingMensal || {});
    rm[chave] = Object.assign({}, rm[chave] || {});
    rm[chave][wkField] = !rm[chave][wkField];
    sv(Object.assign({}, db, {ratingMensal:rm}));
  }

  var saude = useMemo(function() {
    if (!pv || pv.receitaMes <= 0) return {score:0, label:"Sem dados", color:T.dim, emoji:"--", pctFixas:0, pctDiv:0, pctSobra:0, items:[]};
    var receita = pv.receitaMes;
    var pF = (totalFixas / receita) * 100;
    var pP = (totalParcMes / receita) * 100;
    var pTotal = ((totalFixas + totalParcMes) / receita) * 100;
    var pS = (pv.sobraPrevista / receita) * 100;
    var despesaMediaM = (function(){
      var soma = 0, cont = 0;
      for (var off = 0; off >= -2; off--) {
        var r = addMesRef(mes, ano, off);
        var p = getPrevisão(dbEx, r.mes, r.ano);
        if (p.despLancadas > 0) { soma += p.despLancadas; cont++; }
      }
      return cont > 0 ? soma/cont : pv.despLancadas;
    })();
    var mesesReserva = despesaMediaM > 0 ? pat.inv / despesaMediaM : 0;
    var divAtivas = (db.dividas || []).filter(function(d){return !d.quitada});
    var temAcordo = divAtivas.some(function(d){return (d.nome||"").toLowerCase().indexOf("acordo") >= 0 || (d.nome||"").toLowerCase().indexOf("serasa") >= 0});
    var parcCount = parcelas.length;

    var sc = 0;
    var items = [];

    // 1. COMPROMETIMENTO TOTAL (0-25pts)
    if (pTotal <= 50) { sc += 25; items.push({t:"Comprometimento saudável: "+pct(pTotal)+" da renda",s:"ok"}); }
    else if (pTotal <= 60) { sc += 18; items.push({t:"Comprometimento moderado: "+pct(pTotal)+" da renda",s:"ok"}); }
    else if (pTotal <= 70) { sc += 12; items.push({t:"Comprometimento alto: "+pct(pTotal)+" da renda",s:"warning"}); }
    else if (pTotal <= 80) { sc += 6; items.push({t:"Comprometimento crítico: "+pct(pTotal)+" da renda",s:"danger"}); }
    else { sc += 2; items.push({t:"Comprometimento extremo: "+pct(pTotal)+" da renda",s:"danger"}); }

    // 2. SOBRA MENSAL (0-20pts)
    if (pS >= 30) { sc += 20; items.push({t:"Sobra excelente: "+pct(pS)+" da renda ("+f$(pv.sobraPrevista)+")",s:"ok"}); }
    else if (pS >= 20) { sc += 16; items.push({t:"Boa sobra: "+pct(pS)+" da renda",s:"ok"}); }
    else if (pS >= 10) { sc += 12; items.push({t:"Sobra moderada: "+pct(pS)+" da renda",s:"warning"}); }
    else if (pS >= 0) { sc += 5; items.push({t:"Sobra apertada: "+pct(pS)+" da renda",s:"warning"}); }
    else { sc += 0; items.push({t:"Mês deficitário: "+f$(pv.sobraPrevista),s:"danger"}); }

    // 3. RESERVA DE EMERGÊNCIA (0-20pts)
    if (mesesReserva >= 6) { sc += 20; items.push({t:"Reserva sólida: "+mesesReserva.toFixed(1)+" meses de despesas",s:"ok"}); }
    else if (mesesReserva >= 3) { sc += 14; items.push({t:"Reserva razoável: "+mesesReserva.toFixed(1)+" meses",s:"ok"}); }
    else if (mesesReserva >= 1) { sc += 8; items.push({t:"Reserva frágil: "+mesesReserva.toFixed(1)+" meses (ideal: 6+)",s:"warning"}); }
    else if (pat.inv > 0) { sc += 3; items.push({t:"Reserva insuficiente: "+mesesReserva.toFixed(1)+" meses",s:"danger"}); }
    else { sc += 0; items.push({t:"Sem reserva de emergência",s:"danger"}); }

    // 4. ENDIVIDAMENTO (0-20pts)
    if (parcCount === 0 && divAtivas.length === 0) { sc += 20; items.push({t:"Livre de dívidas e parcelas",s:"ok"}); }
    else if (parcCount <= 5 && !temAcordo) { sc += 15; items.push({t:parcCount+" parcelas ativas, sem acordos",s:"ok"}); }
    else if (parcCount <= 15) { sc += 10; items.push({t:parcCount+" parcelas ativas"+(temAcordo?", com acordos Serasa":""),s:"warning"}); }
    else if (parcCount <= 25) { sc += 5; items.push({t:parcCount+" parcelas ativas — alto volume",s:"danger"}); }
    else { sc += 2; items.push({t:parcCount+" parcelas ativas — volume crítico",s:"danger"}); }
    if (temAcordo) sc -= 3;

    // 5. USO DE CARTÕES (0-10pts)
    var meusCards2 = (db.cartoes || []).filter(function(c){return (c.titular||"joao")==="joao" && (c.limite||0) > 0 && (c.limite||0) < 999999});
    var cR2 = cardsResumo.filter(function(c){var isM=false;meusCards2.forEach(function(mc){if(mc.id===c.id)isM=true});return isM});
    var usoMedio2 = cR2.length > 0 ? cR2.reduce(function(s,c){return s+c.usoRealPct},0)/cR2.length : 0;
    if (usoMedio2 <= 15) { sc += 10; }
    else if (usoMedio2 <= 30) { sc += 8; items.push({t:"Uso de cartão: "+pct(usoMedio2)+" (bom)",s:"ok"}); }
    else if (usoMedio2 <= 50) { sc += 5; items.push({t:"Uso de cartão: "+pct(usoMedio2)+" (atenção)",s:"warning"}); }
    else { sc += 2; items.push({t:"Uso de cartão elevado: "+pct(usoMedio2),s:"danger"}); }

    // 6. TENDÊNCIA (0-5pts)
    var parcTerminando = parcelas.filter(function(l){return l.pT > 0 && l.pA > 0 && (l.pT - l.pA) <= 3}).length;
    if (parcTerminando >= 5) { sc += 5; items.push({t:parcTerminando+" parcelas terminando em 3 meses — alívio chegando",s:"ok"}); }
    else if (parcTerminando >= 2) { sc += 3; items.push({t:parcTerminando+" parcelas terminando em breve",s:"ok"}); }
    else { sc += 1; }

    // Patrimônio
    if (pat.liq < 0) { items.push({t:"Patrimônio líquido negativo: "+f$(pat.liq),s:"danger"}); }
    else { items.push({t:"Patrimônio líquido: "+f$(pat.liq),s:pat.liq > receita * 3 ? "ok" : "warning"}); }

    sc = Math.max(0, Math.min(100, Math.round(sc)));
    var lb = sc >= 80 ? "Excelente" : sc >= 65 ? "Boa" : sc >= 50 ? "Atenção" : sc >= 35 ? "Crítica" : "Emergência";
    var cl = sc >= 80 ? T.green : sc >= 65 ? T.greenL : sc >= 50 ? T.gold : sc >= 35 ? T.orange : T.red;
    var em = sc >= 80 ? "A+" : sc >= 65 ? "B" : sc >= 50 ? "C" : sc >= 35 ? "D" : "E";
    return {score:sc, label:lb, color:cl, emoji:em, pctFixas:pF, pctDiv:pP, pctSobra:pS, items:items, mesesReserva:mesesReserva};
  }, [pv, pat, totalFixas, totalParcMes, parcelas, db, cardsResumo, mes, ano, dbEx]);

  var healthScore = saude.score;
  var healthColor = saude.color;
  var healthLabel = saude.label;

  var evolucao = useMemo(function() {
    var acum = 0;
    var data = [];
    for (let m = 1; m <= 12; m++) {
      var pvM = getPrevisão(dbEx, m, ano);
      var temD = pvM.receitaMes > 0 || pvM.despLancadas > 0;
      if (temD) {
        acum += pvM.sobraPrevista;
        data.push({nome:MS[m-1], sobra:Math.round(pvM.sobraPrevista), acum:Math.round(acum), desp:Math.round(pvM.despTotalMes), rec:Math.round(pvM.receitaMes)});
      }
    }
    return data;
  }, [dbEx, ano]);

  var lF = useMemo(function(){
    return lancEx.filter(function(l){
      if(l.mes!==mes||l.ano!==ano) return false;
      if(fTipo&&l.tipo!==fTipo) return false;
      if(fStat&&l.status!==fStat) return false;
      if(fPg&&getMetodoPg(l)!==fPg) return false;
      if(fCard&&String(l.cartaoId||"")!==fCard) return false;
      if(fTitular){var cTit=((db.cartoes||[]).find(function(c){return c.id===l.cartaoId})||{}).titular||"joao";if(l.cartaoId&&cTit!==fTitular)return false;if(!l.cartaoId){var descL=l.desc.toLowerCase();var isBarbara=descL.indexOf("barbara")>=0||descL.indexOf("barb")>=0;if(fTitular==="barbara"&&!isBarbara)return false;if(fTitular==="joao"&&isBarbara)return false;}}
      if(busca&&l.desc.toLowerCase().indexOf(busca.toLowerCase())<0) return false;
      return true;
    }).sort(function(a,b){
      var ma = getMetodoPg(a);
      var mb = getMetodoPg(b);
      var oa = a.tipo==="receita" ? 0 : (ma==="pix" ? 1 : 2);
      var ob = b.tipo==="receita" ? 0 : (mb==="pix" ? 1 : 2);
      if (oa !== ob) return oa - ob;
      return a.data < b.data ? 1 : a.data > b.data ? -1 : 0;
    });
  }, [lancEx,mes,ano,fTipo,fStat,fPg,fCard,fTitular,busca]);

  var gPie = useMemo(function(){
    return Object.keys(res.porC).map(function(id){var ci=catInfo(id);return {name:ci.nome,value:res.porC[id],emoji:ci.emoji,cor:ci.cor,id:id}}).sort(function(a,b){return b.value-a.value});
  }, [res]);
  var cardsView = useMemo(function(){
    return cardsResumo.filter(function(c){
      if (fBankCards && (c.bankKey || inferBankKey(c.nome)) !== fBankCards) return false;
      if (fFatStatus === "aberta" && (!c.faturas[0] || c.faturas[0].paga || c.faturas[0].total <= 0)) return false;
      if (fFatStatus === "paga" && (!c.faturas[0] || !c.faturas[0].paga)) return false;
      if (fFatStatus === "divergencia" && !c.faturas.some(function(f){ return !f.conciliado; })) return false;
      if (fDivCards === "com" && !c.faturas.some(function(f){ return !f.conciliado; })) return false;
      if (fDivCards === "sem" && c.faturas.some(function(f){ return !f.conciliado; })) return false;
      return true;
    });
  }, [cardsResumo, fBankCards, fFatStatus, fDivCards]);
  var historicoRatingData = useMemo(function(){
    var tasks = getRatingTasks();
    var data = [];
    for (let offset = -5; offset <= 0; offset++) {
      var ref = addMesRef(mes, ano, offset);
      var key = ref.ano + "-" + (ref.mes<10?"0":"") + ref.mes;
      var mesR = (db.ratingMensal && db.ratingMensal[key]) || {};
      var ck = tasks.reduce(function(s,t){ return s + (mesR[t.id] ? 8.75 : 0); }, 0);
      if (offset === 0) {
        data.push({nome:MS[ref.mes-1], geral:ratingScore, santander:planoSantander.score, itau:planoItau.score});
      } else if (offset === -1) {
        data.push({nome:MS[ref.mes-1], geral:ratingAnterior.score, santander:planoSantanderAnt.score, itau:planoItauAnt.score});
      } else {
        var est = Math.round(Math.min(100, ck + 15));
        data.push({nome:MS[ref.mes-1], geral:est, santander:est, itau:est});
      }
    }
    return data;
  }, [mes, ano, db.ratingMensal, ratingScore, ratingAnterior.score, planoSantander.score, planoItau.score, planoSantanderAnt.score, planoItauAnt.score]);

  
  return (
    <div onDragOver={function(e){e.preventDefault()}} onDrop={function(e){e.preventDefault();var ff=e.dataTransfer.files;if(ff&&ff[0])handleFile(ff[0])}} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} className="tab-content" key={tab} style={{minHeight:"100vh",background:"transparent",color:T.text,fontFamily:"'Space Grotesk', system-ui, -apple-system, sans-serif",paddingBottom:82,position:"relative",overflowX:"hidden",zIndex:10}}>
      <style>{"@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Geist+Mono:wght@300;400;500;600&family=Instrument+Serif:ital@0;1&display=swap');@keyframes fi{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}@keyframes tabIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes pulse{0%,100%{opacity:.5;transform:scale(0.9)}50%{opacity:1;transform:scale(1.15)}}@keyframes pulseSoft{0%,100%{opacity:1}50%{opacity:0.5}}@keyframes shimmerSlide{0%{transform:translateX(-120%) skewX(-18deg)}100%{transform:translateX(220%) skewX(-18deg)}}@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes slideUp{from{opacity:0;transform:translateY(20px) scale(0.96)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes orb{0%{transform:scale(0.7);opacity:.9}100%{transform:scale(1.5);opacity:0}}@keyframes rotSlow{to{transform:rotate(360deg)}}@keyframes shine{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}@keyframes auroraShift{0%,100%{filter:blur(120px) saturate(1.4) hue-rotate(0deg)}50%{filter:blur(120px) saturate(1.5) hue-rotate(15deg)}}@keyframes countUp{from{opacity:0.3;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}@keyframes confettiFall{0%{transform:translateY(0) rotate(0deg);opacity:1}100%{transform:translateY(100vh) rotate(720deg);opacity:0}}@keyframes celebratePulse{0%,100%{transform:scale(1);filter:brightness(1)}50%{transform:scale(1.06);filter:brightness(1.25) drop-shadow(0 0 24px " + T.cyan + ")}}*{box-sizing:border-box}body{margin:0;padding:0;color:" + T.text + ";font-family:'Space Grotesk',system-ui,-apple-system,sans-serif;letter-spacing:-0.005em;background:radial-gradient(ellipse 70% 50% at 15% 0%, rgba(0,245,212,0.18), transparent 60%),radial-gradient(ellipse 70% 50% at 100% 100%, rgba(123,76,255,0.14), transparent 60%),radial-gradient(ellipse 50% 40% at 50% 50%, rgba(255,0,229,0.06), transparent 70%)," + T.bg + ";min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}.aurora{position:fixed;inset:-10%;pointer-events:none;z-index:0;overflow:hidden;filter:blur(120px) saturate(1.6);opacity:0.55;animation:auroraShift 30s ease-in-out infinite}.aurora svg{width:100%;height:100%;display:block}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.12);border-radius:999px;transition:background 0.2s}::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.22)}::-webkit-scrollbar-track{background:transparent}button{transition:transform 0.25s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.25s cubic-bezier(0.2,0.8,0.2,1), background 0.2s;font-family:inherit}button:hover{transform:translateY(-1px)}button:active{transform:scale(0.97)}button:focus-visible,a:focus-visible,[role='button']:focus-visible{outline:2px solid " + T.cyan + ";outline-offset:3px;border-radius:6px}input:focus,select:focus,textarea:focus{border-color:" + T.cyan + "66 !important;box-shadow:0 0 0 3px " + T.cyan + "22 !important;outline:none}select{appearance:none;-webkit-appearance:none;background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2393A3BC' stroke-width='2' stroke-linecap='round'><path d='M6 9l6 6 6-6'/></svg>\");background-repeat:no-repeat;background-position:right 8px center;padding-right:24px !important}.tab-content{animation:tabIn 0.45s cubic-bezier(0.2,0.8,0.2,1)}.mono-num,.mono{font-family:'Geist Mono','SF Mono',monospace;font-variant-numeric:tabular-nums}.serif-title{font-family:'Instrument Serif',serif;font-weight:400;letter-spacing:-0.015em}.gradient-num{background:linear-gradient(180deg,#fff 20%,#a6bcd6);-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent}.panel-glass{background:linear-gradient(135deg, rgba(10,14,28,0.30), rgba(14,18,36,0.16));backdrop-filter:blur(40px) saturate(1.9);-webkit-backdrop-filter:blur(40px) saturate(1.9);border:1px solid rgba(0,245,212,0.10);box-shadow:0 24px 60px -24px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -1px 0 rgba(0,0,0,0.18)}.kicker{font-family:'Geist Mono';font-size:12px;color:" + T.dim + ";letter-spacing:0.22em;text-transform:uppercase}.chip-pill{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;font-family:'Geist Mono';font-size:12px;letter-spacing:0.08em;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:" + T.muted + "}.chip-up{color:" + T.green + ";border-color:" + T.green + "55;background:" + T.green + "11}.chip-dn{color:" + T.orange + ";border-color:" + T.orange + "55;background:" + T.orange + "11}.count-up{animation:countUp 0.6s ease-out both}.terminal-readout{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;background:rgba(5,8,18,0.5);border:1px solid " + T.cyan + "22;font-family:'Geist Mono',monospace;font-size:12px;color:" + T.cyan + ";letter-spacing:0.14em}.terminal-readout .tl-dot{width:5px;height:5px;border-radius:50%;background:" + T.green + ";box-shadow:0 0 6px " + T.green + ";animation:pulse 1.6s ease-in-out infinite}.blink-cursor::after{content:'_';color:" + T.cyan + ";animation:blink 1s steps(1) infinite;margin-left:2px}.reveal{opacity:0;transform:translateY(20px)}.reveal-in{opacity:1 !important;transform:translateY(0) !important;transition:opacity 0.5s cubic-bezier(0.2,0.8,0.2,1), transform 0.5s cubic-bezier(0.2,0.8,0.2,1)}.micro-lift{transition:transform 0.3s cubic-bezier(0.2,0.8,0.2,1), box-shadow 0.3s cubic-bezier(0.2,0.8,0.2,1)}.micro-lift:hover{transform:translateY(-3px);box-shadow:0 30px 60px -20px rgba(0,0,0,0.6), 0 0 40px -14px " + T.cyan + "}@keyframes rippleExpand{from{transform:scale(0);opacity:0.45}to{transform:scale(3);opacity:0}}.ripple-host{position:relative;overflow:hidden}.ripple-host .ripple{position:absolute;border-radius:50%;background:rgba(255,255,255,0.35);pointer-events:none;animation:rippleExpand 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards}@keyframes toastIn{from{opacity:0;transform:translateY(12px) scale(0.95)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes toastOut{to{opacity:0;transform:translateX(100%) scale(0.95)}}.toast-item{animation:toastIn 0.35s cubic-bezier(0.34,1.56,0.64,1) both;backdrop-filter:blur(40px) saturate(2);-webkit-backdrop-filter:blur(40px) saturate(2)}.toast-item.leaving{animation:toastOut 0.25s ease-out forwards}.row-hover{transition:background 0.15s cubic-bezier(0.2,0.8,0.2,1), border-color 0.15s}.row-hover:hover{background:rgba(255,255,255,0.035) !important}.row-hover:nth-child(even){background:rgba(255,255,255,0.014)}.modal-backdrop{position:fixed;inset:0;z-index:999;background:rgba(0,0,0,0.30);backdrop-filter:blur(32px) saturate(1.4);-webkit-backdrop-filter:blur(32px) saturate(1.4);animation:fadeIn 0.22s ease-out}.modal-panel{animation:slideUp 0.32s cubic-bezier(0.34,1.56,0.64,1)}.celebrate-pulse{animation:celebratePulse 0.9s cubic-bezier(0.2,0.8,0.2,1)}.confetti-piece{position:fixed;top:-10px;width:8px;height:12px;z-index:9998;pointer-events:none;animation:confettiFall 2.4s cubic-bezier(0.2,0.8,0.2,1) forwards}.custom-tooltip{background:rgba(10,14,28,0.55) !important;backdrop-filter:blur(40px) saturate(1.9) !important;-webkit-backdrop-filter:blur(40px) saturate(1.9) !important;border:1px solid rgba(0,245,212,0.18) !important;border-radius:10px !important;padding:10px 14px !important;box-shadow:0 12px 40px -10px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06) !important;font-family:'Space Grotesk',sans-serif !important}.custom-tooltip .label{font-family:'Geist Mono',monospace !important;font-size:11px !important;color:" + T.dim + " !important;letter-spacing:0.12em !important;text-transform:uppercase !important;margin-bottom:4px !important}.custom-tooltip .value{font-family:'Geist Mono',monospace !important;font-size:13px !important;color:" + T.text + " !important;font-variant-numeric:tabular-nums}@keyframes holoShimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}@keyframes dataFlow{0%{transform:translateX(-100%);opacity:0}50%{opacity:1}100%{transform:translateX(100%);opacity:0}}@keyframes glitchSlide{0%,90%,100%{clip-path:inset(0 0 0 0);transform:translate(0)}92%{clip-path:inset(20% 0 50% 0);transform:translate(-1px,0)}94%{clip-path:inset(60% 0 10% 0);transform:translate(1px,0)}96%{clip-path:inset(30% 0 40% 0);transform:translate(-0.5px,0)}}@keyframes cornerPulse{0%,100%{opacity:0.5}50%{opacity:1}}@keyframes scanSweep{0%{transform:translateY(-100%);opacity:0}10%,90%{opacity:0.6}100%{transform:translateY(100%);opacity:0}}@keyframes ringSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}@keyframes neonFlicker{0%,18%,22%,25%,53%,57%,100%{opacity:1;filter:drop-shadow(0 0 6px currentColor)}20%,24%,55%{opacity:0.85;filter:drop-shadow(0 0 2px currentColor)}}.holo-text{background:linear-gradient(110deg,#00F5D4,#FF00E5,#7B4CFF,#00F5D4);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;animation:holoShimmer 6s linear infinite}.hud-card{position:relative}.hud-card::before,.hud-card::after{content:'';position:absolute;width:12px;height:12px;pointer-events:none;animation:cornerPulse 2.4s ease-in-out infinite;z-index:2}.hud-card::before{top:6px;left:6px;border-top:1px solid rgba(0,245,212,0.7);border-left:1px solid rgba(0,245,212,0.7)}.hud-card::after{bottom:6px;right:6px;border-bottom:1px solid rgba(0,245,212,0.7);border-right:1px solid rgba(0,245,212,0.7)}.data-line{position:relative;height:1px;background:rgba(0,245,212,0.10);overflow:hidden}.data-line::after{content:'';position:absolute;top:0;left:0;width:30%;height:100%;background:linear-gradient(90deg,transparent,#00F5D4,transparent);animation:dataFlow 3s ease-in-out infinite}.scan-overlay{position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,transparent 0px,transparent 3px,rgba(0,245,212,0.018) 3px,rgba(0,245,212,0.018) 4px);border-radius:inherit;mix-blend-mode:overlay}.scan-sweep{position:absolute;inset:0;pointer-events:none;overflow:hidden;border-radius:inherit}.scan-sweep::after{content:'';position:absolute;left:0;right:0;height:60%;background:linear-gradient(180deg,transparent,rgba(0,245,212,0.07),transparent);animation:scanSweep 8s linear infinite}.glow-cyan{box-shadow:0 0 24px rgba(0,245,212,0.20), inset 0 1px 0 rgba(255,255,255,0.06)}.glow-purple{box-shadow:0 0 24px rgba(123,76,255,0.18), inset 0 1px 0 rgba(255,255,255,0.06)}.glow-green{box-shadow:0 0 24px rgba(168,255,62,0.20), inset 0 1px 0 rgba(255,255,255,0.06)}.glow-amber{box-shadow:0 0 24px rgba(255,184,0,0.18), inset 0 1px 0 rgba(255,255,255,0.06)}.neon-flicker{animation:neonFlicker 4.5s infinite}.hex-grid-bg{background-image:radial-gradient(circle at 1px 1px, rgba(0,245,212,0.10) 1px, transparent 0);background-size:18px 18px}.tag-mono{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:4px;font-family:'Geist Mono',monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;background:rgba(0,245,212,0.08);border:1px solid rgba(0,245,212,0.2);color:#00F5D4}.tag-mono.tag-up{background:rgba(168,255,62,0.10);border-color:rgba(168,255,62,0.25);color:#A8FF3E}.tag-mono.tag-dn{background:rgba(255,90,31,0.10);border-color:rgba(255,90,31,0.28);color:#FF5A1F}.tag-mono.tag-holo{background:rgba(255,0,229,0.08);border-color:rgba(255,0,229,0.22);color:#FF00E5}.live-dot{position:relative;display:inline-block;width:6px;height:6px;border-radius:50%;background:#00F5D4;box-shadow:0 0 8px #00F5D4,0 0 12px rgba(0,245,212,0.4)}.live-dot::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:1px solid rgba(0,245,212,0.5);animation:orb 1.6s ease-out infinite}.metric-card{position:relative;background:linear-gradient(135deg,rgba(10,14,28,0.85),rgba(14,18,36,0.65));border:1px solid rgba(0,245,212,0.18);border-radius:14px;padding:16px;overflow:hidden;transition:transform 0.3s cubic-bezier(0.2,0.8,0.2,1),border-color 0.3s,box-shadow 0.3s}.metric-card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,#00F5D4,transparent);opacity:0.6}.metric-card:hover{transform:translateY(-2px);border-color:rgba(0,245,212,0.4);box-shadow:0 12px 40px -10px rgba(0,245,212,0.18)}.metric-card.metric-purple{border-color:rgba(123,76,255,0.18)}.metric-card.metric-purple::before{background:linear-gradient(90deg,transparent,#7B4CFF,transparent)}.metric-card.metric-purple:hover{border-color:rgba(123,76,255,0.4);box-shadow:0 12px 40px -10px rgba(123,76,255,0.18)}.metric-card.metric-green{border-color:rgba(168,255,62,0.18)}.metric-card.metric-green::before{background:linear-gradient(90deg,transparent,#A8FF3E,transparent)}.metric-card.metric-green:hover{border-color:rgba(168,255,62,0.4);box-shadow:0 12px 40px -10px rgba(168,255,62,0.18)}.metric-card.metric-amber{border-color:rgba(255,184,0,0.18)}.metric-card.metric-amber::before{background:linear-gradient(90deg,transparent,#FFB800,transparent)}.metric-card.metric-amber:hover{border-color:rgba(255,184,0,0.4);box-shadow:0 12px 40px -10px rgba(255,184,0,0.18)}@keyframes breathe{0%,100%{transform:scale(1);filter:brightness(1)}50%{transform:scale(1.005);filter:brightness(1.04)}}@keyframes floatY{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}@keyframes floatYS{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}@keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}@keyframes borderFlow{0%{background-position:0% 0%}100%{background-position:300% 0%}}@keyframes particleDrift{0%{transform:translate(0,0)}25%{transform:translate(15px,-10px)}50%{transform:translate(-8px,-20px)}75%{transform:translate(-15px,8px)}100%{transform:translate(0,0)}}@keyframes tickerScroll{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}@keyframes staggerIn{from{opacity:0;transform:translateY(14px) scale(0.97)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes drawIn{from{stroke-dashoffset:200}to{stroke-dashoffset:0}}@keyframes glowPulse{0%,100%{box-shadow:0 0 0 0 rgba(0,245,212,0.3)}50%{box-shadow:0 0 0 8px rgba(0,245,212,0)}}@keyframes orbitRing{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}@keyframes wave{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}@keyframes pulseScale{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.08);opacity:0.85}}@keyframes drift{0%{transform:translate(0,0) rotate(0deg)}33%{transform:translate(30px,-20px) rotate(120deg)}66%{transform:translate(-20px,-40px) rotate(240deg)}100%{transform:translate(0,0) rotate(360deg)}}@keyframes burstRay{0%{opacity:0;transform:scale(0.2)}30%{opacity:1}100%{opacity:0;transform:scale(1.6)}}@keyframes sparkleOut{0%{opacity:0;transform:scale(0)}30%{opacity:1;transform:scale(1.4)}100%{opacity:0;transform:scale(0.2) translate(0,8px)}}@keyframes ringBurst{0%{opacity:0;transform:scale(0.4)}25%{opacity:0.85}100%{opacity:0;transform:scale(8)}}@keyframes revealUp{from{opacity:0;transform:translateY(28px) scale(0.97)}to{opacity:1;transform:translateY(0) scale(1)}}.parallax-3d{transform-style:preserve-3d;transition:transform 0.4s cubic-bezier(0.2,0.8,0.2,1);will-change:transform}.parallax-3d:hover{transform:perspective(1100px) rotateX(var(--ry,0deg)) rotateY(var(--rx,0deg)) translateZ(0)}.parallax-3d > *{transform:translateZ(0);transition:transform 0.4s cubic-bezier(0.2,0.8,0.2,1)}.parallax-3d:hover > .lift-1{transform:translateZ(20px)}.parallax-3d:hover > .lift-2{transform:translateZ(36px)}.parallax-3d:hover > .lift-3{transform:translateZ(56px)}.reveal-on-scroll{opacity:0;transform:translateY(28px) scale(0.97);transition:opacity 0.7s cubic-bezier(0.2,0.8,0.2,1),transform 0.7s cubic-bezier(0.2,0.8,0.2,1)}.reveal-on-scroll.is-visible{opacity:1;transform:translateY(0) scale(1)}.breathe{animation:breathe 5s ease-in-out infinite}.breathe-slow{animation:breathe 8s ease-in-out infinite}.float-y{animation:floatY 6s ease-in-out infinite}.float-y-soft{animation:floatYS 4s ease-in-out infinite}.glow-pulse{animation:glowPulse 2.4s ease-out infinite}.border-flow{position:relative}.border-flow::before{content:'';position:absolute;inset:-1px;border-radius:inherit;padding:1px;background:linear-gradient(110deg,rgba(0,245,212,0.6),rgba(123,76,255,0.6),rgba(255,0,229,0.5),rgba(168,255,62,0.5),rgba(0,245,212,0.6));background-size:300% 100%;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:borderFlow 8s linear infinite;pointer-events:none;opacity:0.7}.gradient-anim{background:linear-gradient(110deg,#00F5D4,#7B4CFF,#FF00E5,#A8FF3E,#00F5D4);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;animation:gradientShift 8s ease infinite}.stagger-children > *{animation:staggerIn 0.6s cubic-bezier(0.2,0.8,0.2,1) both}.stagger-children > *:nth-child(1){animation-delay:0.05s}.stagger-children > *:nth-child(2){animation-delay:0.1s}.stagger-children > *:nth-child(3){animation-delay:0.15s}.stagger-children > *:nth-child(4){animation-delay:0.2s}.stagger-children > *:nth-child(5){animation-delay:0.25s}.stagger-children > *:nth-child(6){animation-delay:0.3s}.stagger-children > *:nth-child(7){animation-delay:0.35s}.stagger-children > *:nth-child(8){animation-delay:0.4s}.stagger-children > *:nth-child(9){animation-delay:0.45s}.stagger-children > *:nth-child(n+10){animation-delay:0.5s}.hover-tilt{transition:transform 0.4s cubic-bezier(0.2,0.8,0.2,1),box-shadow 0.4s,filter 0.4s}.hover-tilt:hover{transform:translateY(-3px) scale(1.012);filter:brightness(1.06)}.magnetic{position:relative;overflow:hidden}.magnetic::after{content:'';position:absolute;inset:0;border-radius:inherit;background:radial-gradient(420px circle at var(--mx,50%) var(--my,50%),rgba(0,245,212,0.10),transparent 40%);pointer-events:none;opacity:0;transition:opacity 0.4s}.magnetic:hover::after{opacity:1}.particles-layer{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}.particle{position:absolute;width:3px;height:3px;border-radius:50%;background:#00F5D4;box-shadow:0 0 6px #00F5D4,0 0 12px rgba(0,245,212,0.4);opacity:0.55}.particle.p-purple{background:#7B4CFF;box-shadow:0 0 6px #7B4CFF,0 0 12px rgba(123,76,255,0.4)}.particle.p-holo{background:#FF00E5;box-shadow:0 0 6px #FF00E5,0 0 12px rgba(255,0,229,0.4)}.particle.p-green{background:#A8FF3E;box-shadow:0 0 6px #A8FF3E,0 0 12px rgba(168,255,62,0.4)}.ticker-line{display:flex;overflow:hidden;mask-image:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent);-webkit-mask-image:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent)}.ticker-line > .ticker-track{display:flex;animation:tickerScroll 50s linear infinite;flex-shrink:0;gap:24px;padding-right:24px}.ticker-line:hover > .ticker-track{animation-play-state:paused}.draw-in path,.draw-in polyline,.draw-in line{stroke-dasharray:200;stroke-dashoffset:200;animation:drawIn 1.6s cubic-bezier(0.2,0.8,0.2,1) forwards}.orbit-ring{animation:orbitRing 24s linear infinite;transform-origin:center}.shine-on-hover{position:relative;overflow:hidden}.shine-on-hover::before{content:'';position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,0.10) 50%,transparent 70%);transform:translateX(-100%);transition:transform 0.7s cubic-bezier(0.2,0.8,0.2,1);pointer-events:none}.shine-on-hover:hover::before{transform:translateX(100%)}@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:0.01ms !important;animation-iteration-count:1 !important;transition-duration:0.01ms !important;scroll-behavior:auto !important}.aurora{animation:none !important}.particle{display:none !important}}@supports(padding:env(safe-area-inset-bottom)){.safe-bottom{padding-bottom:calc(env(safe-area-inset-bottom) + 8px)}.safe-top{padding-top:env(safe-area-inset-top)}}"}</style>
      <div className="aurora" aria-hidden="true">
        <svg viewBox="0 0 1200 800" preserveAspectRatio="none">
          <defs>
            <radialGradient id="aura1" cx="20%" cy="20%" r="45%"><stop offset="0%" stopColor="#00F5D4" stopOpacity="0.55" /><stop offset="100%" stopColor="#00F5D4" stopOpacity="0" /></radialGradient>
            <radialGradient id="aura2" cx="80%" cy="75%" r="45%"><stop offset="0%" stopColor="#7B4CFF" stopOpacity="0.5" /><stop offset="100%" stopColor="#7B4CFF" stopOpacity="0" /></radialGradient>
            <radialGradient id="aura3" cx="50%" cy="50%" r="35%"><stop offset="0%" stopColor="#FF00E5" stopOpacity="0.32" /><stop offset="100%" stopColor="#FF00E5" stopOpacity="0" /></radialGradient>
          </defs>
          <rect width="1200" height="800" fill="url(#aura1)"><animate attributeName="x" values="0;-60;40;0" dur="40s" repeatCount="indefinite" /><animate attributeName="y" values="0;30;-40;0" dur="44s" repeatCount="indefinite" /></rect>
          <rect width="1200" height="800" fill="url(#aura2)"><animate attributeName="x" values="0;70;-40;0" dur="48s" repeatCount="indefinite" /><animate attributeName="y" values="0;-40;60;0" dur="42s" repeatCount="indefinite" /></rect>
          <rect width="1200" height="800" fill="url(#aura3)"><animate attributeName="x" values="0;-100;80;0" dur="62s" repeatCount="indefinite" /><animate attributeName="y" values="0;60;-60;0" dur="58s" repeatCount="indefinite" /></rect>
        </svg>
      </div>
      <div className="particles-layer" aria-hidden="true">
        {(function(){
          var rows = [];
          var palette = ["", "p-purple", "p-holo", "p-green", "", "p-purple"];
          for (var i = 0; i < 22; i++) {
            var seedX = (i * 53) % 100;
            var seedY = (i * 79) % 100;
            var dur = 18 + (i % 7) * 4;
            var size = 2 + (i % 3);
            var delay = (i * 0.7) % 8;
            rows.push(<span key={"prt"+i} className={"particle "+palette[i % palette.length]} style={{left:seedX+"%",top:seedY+"%",width:size,height:size,animation:"drift "+dur+"s ease-in-out "+delay+"s infinite, floatY "+(dur/2)+"s ease-in-out infinite"}} />);
          }
          return rows;
        })()}
      </div>
      {booting && <LoadingIntro onComplete={function(){
        setBooting(false);
        if (typeof window !== "undefined") sessionStorage.setItem("cojur_booted", "1");
      }} />}
      {achQueue.length > 0 && <AchievementUnlockModal ach={achQueue[0]} onClose={function(){
        setAchQueue(function(prev){ return prev.slice(1); });
      }} />}
      {achPanelOpen && <AchievementsPanel open={achPanelOpen} unlocked={(db && db.achievements) || {}} onClose={function(){ setAchPanelOpen(false); }} />}
      <input ref={fr} type="file" accept=".json" onChange={function(e){var ff=e.target.files;if(ff&&ff[0])handleFile(ff[0]);e.target.value=""}} style={{display:"none"}} />

      {cfm && <div onClick={function(){setCfm(null)}} className="modal-backdrop" style={{display:"flex",alignItems:"center",justifyContent:"center",zIndex:1001}}>
        <div onClick={function(e){e.stopPropagation()}} className="modal-panel" style={{background:"rgba(10,10,24,0.95)",borderRadius:16,padding:24,border:"1px solid rgba(0,229,255,0.12)",maxWidth:340,width:"90%",textAlign:"center",boxShadow:"0 40px 80px -20px rgba(0,0,0,0.8), 0 0 40px rgba(0,229,255,0.08)"}}>
          <div style={{width:40,height:40,borderRadius:12,background:"rgba(255,46,91,0.12)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px",boxShadow:"0 0 20px rgba(255,46,91,0.15)"}}><AlertTriangle size={20} color={T.red} /></div>
          <div style={{fontSize:14,fontWeight:700,marginBottom:16}}>{cfm.msg}</div>
          <div style={{display:"flex",gap:8,justifyContent:"center"}}>
            <button onClick={function(){setCfm(null)}} style={{padding:"8px 18px",borderRadius:10,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.08)",color:T.text,cursor:"pointer",fontSize:12,fontWeight:600}}>Cancelar</button>
            <button onClick={cfm.fn} style={{padding:"8px 18px",borderRadius:10,background:T.red,border:"none",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700}}>Confirmar</button>
          </div>
        </div>
      </div>}

      {modal && <div onClick={function(){setModal(null)}} style={{position:"fixed",inset:0,background:"rgba(4,5,12,0.35)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999,padding:16,backdropFilter:"blur(36px) saturate(1.6)",WebkitBackdropFilter:"blur(36px) saturate(1.6)",animation:"fi 0.25s"}}>
        <div onClick={function(e){e.stopPropagation()}} style={{background:"linear-gradient(135deg, rgba(14,18,36,0.42), rgba(10,14,28,0.28))",borderRadius:20,padding:24,border:"1px solid rgba(0,245,212,0.16)",maxWidth:520,width:"100%",maxHeight:"85vh",overflow:"auto",boxShadow:"0 40px 100px -30px rgba(0,0,0,0.7), 0 0 60px -20px "+T.cyan+"30, inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.18)",backdropFilter:"blur(48px) saturate(2)",WebkitBackdropFilter:"blur(48px) saturate(2)",position:"relative"}}>
          <div style={{position:"absolute",top:0,left:"10%",right:"10%",height:1,background:"linear-gradient(90deg, transparent, "+T.cyan+"80, transparent)",pointerEvents:"none"}} />
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18,paddingBottom:12,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
            <div>
              <div style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.cyan,letterSpacing:"0.22em",textTransform:"uppercase",marginBottom:4}}>◇ modal</div>
              <h3 className="serif-title" style={{margin:0,fontSize:22,fontWeight:400,letterSpacing:"-0.015em"}}>{modal.title}</h3>
            </div>
            <button onClick={function(){setModal(null)}} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",cursor:"pointer",padding:8,borderRadius:10,display:"flex",transition:"all 0.2s"}}><X size={16} color={T.muted} /></button>
          </div>
          {modal.type==="lanc" && <LForm lanc={modal.data && modal.data.id ? modal.data : null} cats={db.categorias} cards={db.cartoes} onSave={saveLanc} onClose={function(){setModal(null)}} onSuggestCat={suggestCat} aiCatSug={aiCatSug} />}
          {modal.type==="meta" && <SForm fields={[{key:"nome",label:"Nome"},{key:"valor",label:"Valor (R$)"},{key:"prazo",label:"Prazo",type:"date"},{key:"vinc",label:"Vinculo",type:"select",opts:[{v:"invest",l:"Investimentos"},{v:"conta",l:"Saldo"}]}]} data={modal.data} onSave={function(d){ups("metas",Object.assign({},d,{valor:parseBR(d.valor)}))}} onClose={function(){setModal(null)}} />}
          {modal.type==="inv" && <SForm fields={[{key:"nome",label:"Nome"},{key:"valor",label:"Valor (R$)"},{key:"rent",label:"Rent. mensal (%)"},{key:"tipo",label:"Tipo",type:"select",opts:[{v:"cdb",l:"CDB"},{v:"lci",l:"LCI"},{v:"lca",l:"LCA"},{v:"tesouro",l:"Tesouro Direto"},{v:"rf",l:"Renda Fixa"},{v:"rv",l:"Renda Variável"},{v:"fundo",l:"Fundo"},{v:"poupanca",l:"Poupança"},{v:"previdencia",l:"Previdência"},{v:"outro",l:"Outro"}]},{key:"banco",label:"Banco",type:"select",opts:[{v:"santander",l:"Santander"},{v:"itau",l:"Itaú"},{v:"bradesco",l:"Bradesco"},{v:"xp",l:"XP"},{v:"nubank",l:"Nubank"},{v:"btg",l:"BTG"},{v:"inter",l:"Inter"},{v:"outro",l:"Outro"}]},{key:"liquidez",label:"Liquidez",type:"select",opts:[{v:"diaria",l:"Diária"},{v:"90d",l:"90 dias"},{v:"180d",l:"180 dias"},{v:"360d",l:"360 dias"},{v:"vencimento",l:"No vencimento"}]}]} data={modal.data} onSave={function(d){ups("investimentos",Object.assign({},d,{valor:parseBR(d.valor),rent:parseFloat(String(d.rent).replace(",","."))||0,tipo:d.tipo||"cdb",banco:d.banco||"santander",liquidez:d.liquidez||"diaria"}))}} onClose={function(){setModal(null)}} />}
          {modal.type==="div" && <SForm fields={[{key:"nome",label:"Nome"},{key:"total",label:"Total"},{key:"pago",label:"Pago"},{key:"parcela",label:"Parcela"},{key:"pRest",label:"Restantes",type:"number"},{key:"vDia",label:"Dia venc.",type:"number"},{key:"taxa",label:"Taxa %"}]} data={modal.data} onSave={function(d){ups("dividas",Object.assign({},d,{total:parseBR(d.total),pago:parseBR(d.pago),parcela:parseBR(d.parcela),pRest:parseInt(d.pRest)||0,vDia:parseInt(d.vDia)||1,taxa:parseFloat(String(d.taxa).replace(",","."))||0}))}} onClose={function(){setModal(null)}} />}
          {modal.type==="conta" && <SForm fields={[{key:"nome",label:"Nome"},{key:"saldo",label:"Saldo (R$)"}]} data={modal.data} onSave={function(d){ups("contas",Object.assign({},d,{saldo:parseBR(d.saldo)}))}} onClose={function(){setModal(null)}} />}
          {modal.type==="card" && <SForm fields={[{key:"nome",label:"Nome do cartao"},{key:"bankKey",label:"Banco",type:"select",opts:BANK_OPTIONS},{key:"band",label:"Bandeira"},{key:"limite",label:"Limite (R$)"},{key:"fecha",label:"Fecha dia",type:"number"},{key:"venc",label:"Vence dia",type:"number"},{key:"cor",label:"Cor principal"},{key:"cor2",label:"Cor secundaria"},{key:"visual",label:"Estilo visual",type:"select",opts:[{v:"black",l:"Black"},{v:"metal",l:"Metal"},{v:"executive",l:"Executive"},{v:"classic",l:"Classic"},{v:"fintech",l:"Fintech"}]},{key:"statusEstr",label:"Status estrategico",type:"select",opts:[{v:"foco_mes",l:"Foco do mês"},{v:"usar_moderadamente",l:"Usar moderadamente"},{v:"concentrar_gastos",l:"Concentrar gastos"},{v:"manter_estável",l:"Manter estável"},{v:"evitar_uso_alto",l:"Evitar uso alto"},{v:"prioritario",l:"Cartao prioritario"}]},{key:"logoUrl",label:"Logo URL"},{key:"emoji",label:"Emoji"},{key:"obs",label:"Observacao estrategica"}]} data={modal.data} onSave={function(d){ups("cartoes",Object.assign({},d,{limite:parseBR(d.limite),fecha:parseInt(d.fecha)||1,venc:parseInt(d.venc)||1,cor:d.cor||T.blue,cor2:d.cor2||"",band:d.band||"Cartao",obs:d.obs||"",bankKey:d.bankKey||inferBankKey(d.nome||d.band),visual:d.visual||"black",statusEstr:d.statusEstr||"manter_estável",logoUrl:d.logoUrl||"",emoji:d.emoji||""}))}} onClose={function(){setModal(null)}} />}
          {modal.type==="cat" && <SForm fields={[{key:"nome",label:"Nome"},{key:"tipo",label:"Tipo",type:"select",opts:[{v:"despesa",l:"Despesa"},{v:"receita",l:"Receita"}]},{key:"orc",label:"Orçamento mensal (R$)"}]} data={modal.data} onSave={function(d){ups("categorias",Object.assign({},d,{orc:parseBR(d.orc)}))}} onClose={function(){setModal(null)}} />}
          {modal.type==="cloud" && (function(){
            var u = sync.user;
            var statusLabel = {synced:"Sincronizado", syncing:"Sincronizando...", connecting:"Conectando", offline:"Offline", error:"Erro de sincronia", signed_out:"Não conectado"}[sync.status] || sync.status;
            return <div style={{padding:4}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:18}}>
                {u && u.user_metadata && u.user_metadata.avatar_url
                  ? <img src={u.user_metadata.avatar_url} alt="" style={{width:48,height:48,borderRadius:"50%",border:"1px solid "+T.cyan+"55"}}/>
                  : <div style={{width:48,height:48,borderRadius:"50%",background:T.cyan+"15",border:"1px solid "+T.cyan+"55",display:"flex",alignItems:"center",justifyContent:"center"}}><User size={22} color={T.cyan}/></div>}
                <div>
                  <div style={{fontSize:14,fontWeight:600,color:T.text}}>{u && (u.user_metadata && u.user_metadata.full_name || u.email) || "Usuário"}</div>
                  <div style={{fontSize:11,color:T.muted,fontFamily:FF.mono}}>{u && u.email}</div>
                </div>
              </div>
              <div style={{padding:"12px 14px",borderRadius:12,background:T.cyan+"08",border:"1px solid "+T.cyan+"22",marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:T.muted,marginBottom:4}}>
                  <span>STATUS</span>
                  <span style={{color:sync.status==="synced"?T.green:sync.status==="error"?T.red:T.cyan,fontFamily:FF.mono}}>{statusLabel}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:T.muted,marginBottom:4}}>
                  <span>ÚLTIMA SYNC</span>
                  <span style={{color:T.text,fontFamily:FF.mono}}>{sync.lastSync ? sync.lastSync.toLocaleString("pt-BR") : "—"}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:T.muted}}>
                  <span>DEVICE</span>
                  <span style={{color:T.text,fontFamily:FF.mono}}>{DEVICE_ID}</span>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                <button onClick={function(){sync.forceSync().then(function(){flash("Sincronizado!");});}} style={{padding:"10px 14px",borderRadius:10,background:T.cyan+"15",border:"1px solid "+T.cyan+"40",color:T.cyan,cursor:"pointer",fontSize:13,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                  <RefreshCw size={14}/> Forçar sync
                </button>
                <button onClick={function(){sync.signOut().then(function(){setModal(null);flash("Desconectado");});}} style={{padding:"10px 14px",borderRadius:10,background:T.red+"12",border:"1px solid "+T.red+"30",color:T.red,cursor:"pointer",fontSize:13,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                  <LogOut size={14}/> Sair
                </button>
              </div>
              <div style={{marginTop:14,padding:"10px 12px",borderRadius:10,background:T.green+"08",border:"1px solid "+T.green+"22",fontSize:11,color:T.muted,lineHeight:1.6}}>
                Seus dados ficam salvos no Supabase e sincronizam em tempo real entre todos os dispositivos onde você fizer login com este Google.
              </div>
            </div>;
          })()}
        </div>
      </div>}

      <div style={{maxWidth:1260,margin:"0 auto",padding:"14px 16px 36px",position:"relative"}}>
        <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,background:"radial-gradient(ellipse at 20% 0%, rgba(0,255,136,0.08), transparent 50%), radial-gradient(ellipse at 80% 100%, rgba(184,77,255,0.06), transparent 50%), radial-gradient(ellipse at 50% 50%, rgba(0,229,255,0.04), transparent 60%), radial-gradient(ellipse at 90% 20%, rgba(255,0,229,0.03), transparent 55%)"}} />
        <div style={{position:"fixed",left:0,right:0,height:1,background:"linear-gradient(90deg, transparent, "+T.cyan+"15, transparent)",pointerEvents:"none",zIndex:0,animation:"scanLine 6s linear infinite",opacity:0.5}} />
        {}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:12,padding:"16px 18px",borderRadius:16,background:"linear-gradient(135deg, rgba(8,8,20,0.32) 0%, rgba(12,12,30,0.18) 100%)",border:"1px solid rgba(0,229,255,0.16)",backdropFilter:"blur(44px) saturate(1.9)",WebkitBackdropFilter:"blur(44px) saturate(1.9)",boxShadow:"0 0 0 0.5px rgba(0,229,255,0.08), 0 0 50px rgba(0,229,255,0.05), 0 8px 32px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06)",position:"relative",overflow:"hidden"}}>
          <span style={{position:"absolute",top:0,left:0,width:14,height:14,borderTop:"1px solid "+T.cyan+"60",borderLeft:"1px solid "+T.cyan+"60"}} />
          <span style={{position:"absolute",top:0,right:0,width:14,height:14,borderTop:"1px solid "+T.cyan+"60",borderRight:"1px solid "+T.cyan+"60"}} />
          <span style={{position:"absolute",bottom:0,left:0,width:14,height:14,borderBottom:"1px solid "+T.cyan+"60",borderLeft:"1px solid "+T.cyan+"60"}} />
          <span style={{position:"absolute",bottom:0,right:0,width:14,height:14,borderBottom:"1px solid "+T.cyan+"60",borderRight:"1px solid "+T.cyan+"60"}} />
          <div style={{position:"absolute",top:0,left:"15%",right:"15%",height:1,background:"linear-gradient(90deg, transparent, "+T.cyan+"50, transparent)",pointerEvents:"none"}} />
          <div style={{position:"absolute",inset:0,pointerEvents:"none",background:"linear-gradient(90deg, rgba(0,255,136,0.04), transparent 30%, transparent 70%, rgba(0,229,255,0.04))"}} />
          <div style={{display:"flex",alignItems:"center",gap:12,position:"relative",zIndex:1,flexWrap:"wrap"}}>
            <div className="float-y-soft glow-pulse" style={{width:42,height:42,display:"grid",placeItems:"center",borderRadius:12,background:"radial-gradient(circle at 30% 30%, rgba(255,255,255,0.18), transparent 60%), rgba(10,14,28,0.35)",border:"1px solid rgba(0,245,212,0.18)",boxShadow:"0 0 30px -8px "+T.cyan,position:"relative",overflow:"hidden",backdropFilter:"blur(20px) saturate(1.6)",WebkitBackdropFilter:"blur(20px) saturate(1.6)"}}>
              <span style={{position:"absolute",inset:-2,borderRadius:14,border:"1px solid "+T.cyan+"22",animation:"orbitRing 24s linear infinite",pointerEvents:"none"}} />
              <Wallet size={18} color={T.cyan} style={{filter:"drop-shadow(0 0 8px "+T.cyan+")",position:"relative",zIndex:1}} />
            </div>
            <div>
              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:15,letterSpacing:"0.18em"}}>COJUR <span style={{fontWeight:300,color:T.muted}}>VAULT</span></div>
              <div className={privateMode?"":"blink-cursor"} style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.dim,letterSpacing:"0.22em",textTransform:"uppercase",marginTop:3,display:"flex",alignItems:"center",gap:6}}>
                <span style={{width:6,height:6,borderRadius:"50%",background:T.green,boxShadow:"0 0 10px "+T.green,animation:"pulse 1.6s ease-in-out infinite"}} />
                {privateMode?"private · secured":"command deck · live"}
              </div>
            </div>
            <div className="terminal-readout" title="Horário local"><span className="tl-dot" /><span>SYS {liveTime || "--:--:--"}</span></div>
            {(function(){
              if (sync.status === "disabled") return null;
              var col = T.dim, lbl = "OFFLINE", Icon = CloudOff, spin = false;
              if (sync.status === "synced") { col = T.green; lbl = "SYNC OK"; Icon = Cloud; }
              else if (sync.status === "syncing") { col = T.cyan; lbl = "SYNC..."; Icon = RefreshCw; spin = true; }
              else if (sync.status === "connecting") { col = T.cyan; lbl = "CONNECT"; Icon = RefreshCw; spin = true; }
              else if (sync.status === "signed_out") { col = T.gold; lbl = "LOGIN"; Icon = LogIn; }
              else if (sync.status === "error") { col = T.red; lbl = "ERR"; Icon = CloudOff; }
              else if (sync.status === "offline") { col = T.orange; lbl = "OFFLINE"; Icon = CloudOff; }
              return <button onClick={function(){
                if (sync.status === "signed_out") sync.signIn()["catch"](function(e){flash("Erro login: "+e.message);});
                else if (sync.user) setModal({type:"cloud", title:"Cloud Sync"});
                else sync.forceSync();
              }} className="ripple-host" title={"Cloud: "+sync.status+(sync.lastSync?" · "+sync.lastSync.toLocaleTimeString("pt-BR"):"")} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:8,background:"rgba(5,8,18,0.5)",border:"1px solid "+col+"33",color:col,fontFamily:"'Geist Mono',monospace",fontSize:11,letterSpacing:"0.14em",cursor:"pointer"}}>
                <Icon size={12} style={spin?{animation:"rotSlow 1.4s linear infinite"}:{}} />
                <span>{lbl}</span>
              </button>;
            })()}
            {(function(){
              var saldoTot = (db.contas||[]).reduce(function(s,c){return s+(c.saldo||0);},0);
              var saldoK = saldoTot >= 1000 ? (saldoTot/1000).toFixed(1)+"k" : saldoTot.toFixed(0);
              var saldoCol = saldoTot >= 0 ? T.cyan : T.orange;
              return <div className="terminal-readout" title={"Saldo total em contas: "+f$(saldoTot)} style={{borderColor:saldoCol+"33",color:saldoCol}}><span>SAL R$ {privateMode ? "•••" : saldoK}</span></div>;
            })()}
            {metP && metP.total > 0 && (function(){
              var pctMeta = Math.min(999, Math.round((metP.atual/metP.total)*100));
              var metaCol = pctMeta >= 100 ? T.green : pctMeta >= 60 ? T.greenL : pctMeta >= 30 ? T.gold : T.orange;
              return <div className="terminal-readout" title={"Meta: "+(metP.nome||"principal")+" "+pctMeta+"%"} style={{borderColor:metaCol+"33",color:metaCol}}><span>META {String(pctMeta).padStart(2,"0")}%</span></div>;
            })()}
            {(function(){
              var invTot = (db.investimentos||[]).reduce(function(s,i){return s+(i.valor||0);},0);
              if (invTot <= 0) return null;
              var invK = invTot >= 1000 ? (invTot/1000).toFixed(1)+"k" : invTot.toFixed(0);
              return <div className="terminal-readout" title={"Investido: "+f$(invTot)} style={{borderColor:T.purple+"33",color:T.purple}}><span>INV R$ {privateMode ? "•••" : invK}</span></div>;
            })()}
            {(function(){
              var divAtv = (db.dividas||[]).filter(function(d){return (d.pago||0) < (d.total||0);}).length;
              if (divAtv === 0) return null;
              return <div className="terminal-readout" title={"Dívidas ativas: "+divAtv} style={{borderColor:T.red+"33",color:T.red}}><span>DIV {String(divAtv).padStart(2,"0")}</span></div>;
            })()}
          </div>
          <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap",position:"relative",zIndex:1}}>
            {st && <div style={{position:"fixed",top:12,right:12,display:"flex",alignItems:"center",gap:4,padding:"6px 14px",borderRadius:8,fontSize:12,fontWeight:700,background:T.green+"18",color:T.green,animation:"fi 0.3s",zIndex:950,boxShadow:"0 0 20px "+T.green+"30"}}><CheckCircle size={13} />{st}</div>}
            <button onClick={function(){setDarkMode(!darkMode)}} style={{padding:"6px 10px",borderRadius:8,background:darkMode?"rgba(0,229,255,0.06)":"rgba(0,0,0,0.06)",border:"1px solid "+(darkMode?"rgba(0,229,255,0.12)":"rgba(0,0,0,0.10)"),cursor:"pointer",display:"flex",alignItems:"center",gap:4,color:darkMode?T.gold:T.blue,fontSize:12,fontWeight:600}}>{darkMode ? <Sun size={12} /> : <Moon size={12} />}</button>
            <button onClick={function(){setPrivateMode(!privateMode)}} style={{padding:"6px 10px",borderRadius:8,background:privateMode?T.gold+"12":"rgba(0,229,255,0.06)",border:"1px solid "+(privateMode?T.gold+"25":"rgba(0,229,255,0.12)"),cursor:"pointer",display:"flex",alignItems:"center",gap:5,color:privateMode?T.gold:T.cyan,fontSize:12,fontWeight:600}}><Shield size={12} />{privateMode?"ON":"OFF"}</button>
            <button onClick={handleExport} style={{padding:"6px 10px",borderRadius:8,background:"rgba(0,229,255,0.06)",border:"1px solid rgba(0,229,255,0.12)",cursor:"pointer",display:"flex",alignItems:"center",gap:5,color:T.cyan,fontSize:12,fontWeight:600}} title="Exportar JSON"><Download size={12} /></button>
            <button onClick={handleExportCSV} style={{padding:"6px 10px",borderRadius:8,background:"rgba(0,255,136,0.06)",border:"1px solid rgba(0,255,136,0.12)",cursor:"pointer",display:"flex",alignItems:"center",gap:5,color:T.green,fontSize:12,fontWeight:600}} title="Exportar CSV"><Download size={12} /></button>
            <button onClick={exportPDF} style={{padding:"6px 10px",borderRadius:8,background:"rgba(0,229,255,0.06)",border:"1px solid rgba(0,229,255,0.12)",cursor:"pointer",display:"flex",alignItems:"center",gap:5,color:T.purple,fontSize:12,fontWeight:600}} title="Exportar PDF"><BarChart3 size={12} /></button>
            <button onClick={function(){if(fr.current)fr.current.click()}} style={{padding:"6px 10px",borderRadius:8,background:"rgba(0,229,255,0.06)",border:"1px solid rgba(0,229,255,0.12)",cursor:"pointer",display:"flex",alignItems:"center",gap:5,color:T.cyan,fontSize:12,fontWeight:600}}><Upload size={12} /></button>
            <div style={{display:"flex",alignItems:"center",gap:3,padding:"5px 8px",borderRadius:8,background:"rgba(0,229,255,0.06)",border:"1px solid rgba(0,229,255,0.12)"}}><span style={{fontSize:11,color:T.dim,fontWeight:600}}>Dia</span><input type="number" value={db.salarioDia||25} onChange={function(e){updSalarioDia(e.target.value)}} style={{width:24,background:"transparent",border:"none",color:T.cyan,fontSize:12,fontWeight:700,textAlign:"center",outline:"none",padding:0}} min="1" max="31" /></div>
            {(function(){
              var unl = (db && db.achievements) || {};
              var unlockedCount = Object.keys(unl).filter(function(k){return ACHIEVEMENTS.some(function(a){return a.id===k;});}).length;
              return <button onClick={function(){setAchPanelOpen(true);}} title={"Conquistas ("+unlockedCount+"/"+ACHIEVEMENTS.length+")"} style={{padding:"6px 10px",borderRadius:8,background:"linear-gradient(135deg, rgba(255,184,0,0.12), rgba(255,0,229,0.06))",border:"1px solid rgba(255,184,0,0.25)",cursor:"pointer",display:"flex",alignItems:"center",gap:5,color:T.gold,fontSize:12,fontWeight:600,position:"relative",overflow:"hidden"}}>
                <Heart size={12} style={{filter:"drop-shadow(0 0 4px "+T.gold+")"}} />
                <span style={{fontFamily:FF.mono,fontSize:10,letterSpacing:"0.1em"}}>{unlockedCount}/{ACHIEVEMENTS.length}</span>
              </button>;
            })()}
            {hasBackup() && <button onClick={function(){setCfm({msg:"Restaurar o backup anterior a ultima importacao?",fn:function(){restoreBackup();setCfm(null)}})}} style={{padding:6,borderRadius:8,background:"rgba(255,208,0,0.08)",border:"1px solid rgba(255,208,0,0.15)",cursor:"pointer",display:"flex",alignItems:"center",gap:4,color:T.gold,fontSize:11,fontWeight:600}}><RotateCcw size={11} /> Backup</button>}
            <button onClick={function(){setCfm({msg:"Restaurar dados padrão?",fn:function(){sv(DEF);setCfm(null);flash("Restaurado!")}})}} style={{padding:6,borderRadius:8,background:"rgba(0,229,255,0.06)",border:"1px solid rgba(0,229,255,0.12)",cursor:"pointer",display:"flex"}}><RotateCcw size={12} color={T.cyan} /></button>
          </div>
        </div>

        {tab!=="metas" && tab!=="invest" && tab!=="ia" && <div style={{display:"flex",gap:6,marginBottom:10}}>
          <div style={{flex:1,position:"relative"}}>
            <Zap size={13} color={T.green} style={{position:"absolute",left:10,top:9}} />
            <input value={quickInput} onChange={function(e){setQuickInput(e.target.value)}} onKeyDown={function(e){if(e.key==="Enter")quickEntry()}} placeholder="Lançamento rápido: '50 uber pix'" style={Object.assign({},inp,{paddingLeft:30,fontSize:12,borderRadius:12})} />
          </div>
          <button onClick={quickEntry} disabled={aiLoading || !quickInput.trim()} style={{padding:"8px 14px",borderRadius:12,background:aiLoading?"rgba(255,255,255,0.04)":T.green,border:"none",color:aiLoading?T.dim:"#000",cursor:aiLoading?"wait":"pointer",fontSize:12,fontWeight:800,flexShrink:0}}>{aiLoading?"...":"+"}</button>
        </div>}

        {tab!=="metas" && tab!=="invest" && tab!=="ia" && consistency.diasSemLanc >= 3 && <div style={{marginBottom:10,padding:"8px 14px",borderRadius:12,background:T.gold+"08",border:"1px solid "+T.gold+"15",display:"flex",alignItems:"center",gap:8,fontSize:12}}>
          <AlertTriangle size={14} color={T.gold} />
          <span style={{color:T.text,fontWeight:600}}>{consistency.diasSemLanc} dias sem lancamentos.</span>
          <span style={{color:T.dim}}>Possiveis gastos nao registrados.</span>
          <span style={{marginLeft:"auto",color:T.gold,fontWeight:800,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{consistency.score}%</span>
        </div>}

        {tab!=="metas" && tab!=="invest" && tab!=="ia" && <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:14,marginBottom:16,padding:"10px 12px",borderRadius:14,background:"rgba(8,8,20,0.28)",border:"1px solid rgba(0,229,255,0.10)",backdropFilter:"blur(36px) saturate(1.8)",WebkitBackdropFilter:"blur(36px) saturate(1.8)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.05), 0 8px 24px -10px rgba(0,0,0,0.3)"}}>
          <button onClick={prevMes} style={{background:"rgba(5,8,18,0.5)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,padding:"8px 12px",cursor:"pointer",display:"flex",transition:"all 0.2s"}}><ChevronLeft size={16} color={T.cyan} /></button>
          <div style={{textAlign:"center",minWidth:160}}>
            <div className="serif-title" style={{fontSize:24,fontWeight:400,letterSpacing:"-0.015em",lineHeight:1}}>{MSF[mes-1]}</div>
            <div style={{fontFamily:"'Geist Mono',monospace",fontSize:12,color:T.dim,fontWeight:500,letterSpacing:"0.22em",marginTop:3}}>{ano}</div>
          </div>
          <button onClick={nextMes} style={{background:"rgba(5,8,18,0.5)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,padding:"8px 12px",cursor:"pointer",display:"flex",transition:"all 0.2s"}}><ChevronRight size={16} color={T.muted} /></button>
          {(mes !== new Date().getMonth()+1 || ano !== new Date().getFullYear()) && <button onClick={function(){setMes(new Date().getMonth()+1);setAno(new Date().getFullYear())}} style={{padding:"8px 14px",borderRadius:10,background:"rgba(0,245,212,0.10)",border:"1px solid "+T.cyan+"33",cursor:"pointer",color:T.cyan,fontFamily:"'Geist Mono',monospace",fontSize:12,fontWeight:500,letterSpacing:"0.18em",textTransform:"uppercase",boxShadow:"0 0 16px -6px "+T.cyan}}>hoje</button>}
          <div title="Command Palette (⌘K)" onClick={function(){setCmdOpen(true)}} style={{padding:"8px 10px",borderRadius:10,background:"rgba(0,245,212,0.08)",border:"1px solid "+T.cyan+"28",cursor:"pointer",transition:"all 0.2s",display:"flex",alignItems:"center",gap:6,fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.cyan,fontWeight:500,letterSpacing:"0.08em"}}><Search size={12} /><span style={{opacity:0.9}}>⌘K</span></div>
          <div style={{position:"relative",padding:8,borderRadius:10,background:"rgba(5,8,18,0.5)",border:"1px solid rgba(255,255,255,0.08)",cursor:"pointer",transition:"all 0.2s"}} onClick={function(){setTab("alertas")}}><Bell size={14} color={als.length>0?T.orange:T.muted} />{als.length>0&&<div style={{position:"absolute",top:-4,right:-4,minWidth:14,height:14,padding:"0 3px",borderRadius:7,background:"linear-gradient(135deg, "+T.orange+", #FF7A3A)",fontFamily:"'Geist Mono',monospace",fontSize:11,fontWeight:600,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",border:"1px solid rgba(255,255,255,0.2)",boxShadow:"0 0 10px "+T.orange+"AA"}}>{als.length}</div>}</div>
        </div>}

        {}
        <div style={{marginBottom:14,position:"relative"}}>
          <div style={{position:"relative"}}><Search size={14} color={T.dim} style={{position:"absolute",left:12,top:11}} /><input value={gSearch} onChange={function(e){setGSearch(e.target.value)}} placeholder="Pesquisar em tudo..." style={Object.assign({},inp,{paddingLeft:34,fontSize:12,borderRadius:16})} />{gSearch && <button onClick={function(){setGSearch("")}} style={{position:"absolute",right:10,top:9,background:"none",border:"none",cursor:"pointer",padding:2}}><X size={14} color={T.dim} /></button>}</div>
          {gSearch.length >= 2 && (function() {
            var q = gSearch.toLowerCase();
            var rLanc = lancEx.filter(function(l){return l.mes===mes && l.ano===ano && l.desc.toLowerCase().indexOf(q)>=0}).slice(0,5);
            var rCards = (db.cartoes||[]).filter(function(c){return c.nome.toLowerCase().indexOf(q)>=0 || (c.band||"").toLowerCase().indexOf(q)>=0});
            var rDiv = (db.dividas||[]).filter(function(d){return d.nome.toLowerCase().indexOf(q)>=0});
            var rInv = (db.investimentos||[]).filter(function(i){return i.nome.toLowerCase().indexOf(q)>=0});
            var total = rLanc.length + rCards.length + rDiv.length + rInv.length;
            if (total === 0) return <div style={Object.assign({},bx,{marginTop:8,padding:14,textAlign:"center"})}><div style={{fontSize:12,color:T.dim}}>Nenhum resultado para "{gSearch}"</div></div>;
            return <div style={Object.assign({},bx,{marginTop:8,padding:14})}>
              <div style={{fontSize:12,color:T.dim,marginBottom:8}}>{total} resultado(s) encontrado(s)</div>
              {rLanc.length > 0 && <div style={{marginBottom:10}}><div style={{fontSize:11,color:T.cyan,fontWeight:800,textTransform:"uppercase",marginBottom:6}}>Lançamentos</div>{rLanc.map(function(l){return <div key={l.id} onClick={function(){setTab("lanc");setBusca(gSearch);setGSearch("")}} style={{display:"flex",justifyContent:"space-between",padding:"6px 8px",borderRadius:8,background:"rgba(255,255,255,0.02)",marginBottom:3,cursor:"pointer",fontSize:12}}><span style={{color:T.muted}}>{l.desc}</span><span style={{fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700,color:l.tipo==="receita"?T.green:T.red}}>{f$(l.valor)}</span></div>;})}</div>}
              {rCards.length > 0 && <div style={{marginBottom:10}}><div style={{fontSize:11,color:T.blue,fontWeight:800,textTransform:"uppercase",marginBottom:6}}>Cartoes</div>{rCards.map(function(c){return <div key={c.id} onClick={function(){setTab("cards");setGSearch("")}} style={{display:"flex",justifyContent:"space-between",padding:"6px 8px",borderRadius:8,background:"rgba(255,255,255,0.02)",marginBottom:3,cursor:"pointer",fontSize:12}}><span style={{color:T.muted}}>{c.nome}</span><span style={{fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700}}>{f$(c.limite)}</span></div>;})}</div>}
              {rDiv.length > 0 && <div style={{marginBottom:10}}><div style={{fontSize:11,color:T.gold,fontWeight:800,textTransform:"uppercase",marginBottom:6}}>Dívidas</div>{rDiv.map(function(d){return <div key={d.id} onClick={function(){setTab("parc");setGSearch("")}} style={{display:"flex",justifyContent:"space-between",padding:"6px 8px",borderRadius:8,background:"rgba(255,255,255,0.02)",marginBottom:3,cursor:"pointer",fontSize:12}}><span style={{color:T.muted}}>{d.nome}</span><span style={{fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700,color:T.gold}}>{f$(d.parcela)}/m</span></div>;})}</div>}
              {rInv.length > 0 && <div><div style={{fontSize:11,color:T.green,fontWeight:800,textTransform:"uppercase",marginBottom:6}}>Investimentos</div>{rInv.map(function(inv){return <div key={inv.id} onClick={function(){setTab("invest");setGSearch("")}} style={{display:"flex",justifyContent:"space-between",padding:"6px 8px",borderRadius:8,background:"rgba(255,255,255,0.02)",marginBottom:3,cursor:"pointer",fontSize:12}}><span style={{color:T.muted}}>{inv.nome}</span><span style={{fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700,color:T.green}}>{f$(inv.valor)}</span></div>;})}</div>}
            </div>;
          })()}
        </div>

        {}

        {(function(){
          var alertCards = cardsResumo.filter(function(c){return c.usoRealPct > 50 && c.limite < 999999});
          if (alertCards.length === 0) return null;
          return <div style={{marginBottom:12,padding:"10px 14px",borderRadius:12,background:T.red+"08",border:"1px solid "+T.red+"18",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <div style={{width:30,height:30,borderRadius:8,background:T.red+"15",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><AlertTriangle size={14} color={T.red} /></div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:12,fontWeight:800,color:T.red}}>Limite alto em {alertCards.length} cartao(s)</div>
              <div style={{fontSize:12,color:T.muted,marginTop:2}}>{alertCards.map(function(c){return c.nome+" ("+pct(c.usoRealPct)+")"}).join(", ")}</div>
            </div>
            <button onClick={function(){setTab("cards")}} style={{padding:"5px 10px",borderRadius:8,background:T.red+"15",border:"1px solid "+T.red+"25",color:T.red,cursor:"pointer",fontSize:11,fontWeight:700,flexShrink:0}}>Ver cartoes</button>
          </div>;
        })()}

        {showAporteModal && <div className="modal-backdrop" style={{display:"flex",alignItems:"center",justifyContent:"center",padding:20,zIndex:800}} onClick={function(){setShowAporteModal(false)}}>
          <div onClick={function(e){e.stopPropagation()}} style={{background:T.card,border:"1px solid "+T.border,borderRadius:20,padding:24,maxWidth:400,width:"100%"}}>
            <div style={{fontSize:15,fontWeight:900,marginBottom:14,color:T.green}}>Distribuir aportes nas metas</div>
            <div style={{fontSize:12,color:T.muted,marginBottom:14,lineHeight:1.6}}>A sobra do mês ({f$(getPrevisão(db,mes,ano).sobra)}) menos investimento fixo ({f$(db.investimentoFixo||0)}) sera distribuida proporcionalmente entre as metas ativas, conforme o aporte definido em cada uma.</div>
            {(db.metas||[]).filter(function(m){return (m.atual||0)<m.valor}).map(function(m){
              var totalAp = (db.metas||[]).filter(function(x){return (x.atual||0)<x.valor}).reduce(function(s,x){return s+(x.aporte||0)},0);
              var disp = Math.max(0, (getPrevisão(db,mes,ano).sobra||0) - (db.investimentoFixo||0));
              var val = totalAp > 0 ? Math.round(disp * (m.aporte||0) / totalAp * 100)/100 : 0;
              return <div key={m.id} style={{display:"flex",justifyContent:"space-between",padding:"8px 10px",borderRadius:8,background:T.cardAlt,marginBottom:6,fontSize:12}}>
                <span style={{color:T.text,fontWeight:600}}>{m.nome}</span>
                <span style={{color:T.green,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>+{f$(val)}</span>
              </div>;
            })}
            <div style={{display:"flex",gap:8,marginTop:16}}>
              <button onClick={distribuirAporte} style={{flex:1,padding:"10px 16px",borderRadius:10,background:T.green,border:"none",color:"#000",cursor:"pointer",fontSize:12,fontWeight:800}}>Confirmar aportes</button>
              <button onClick={function(){setShowAporteModal(false)}} style={{padding:"10px 16px",borderRadius:10,background:T.card,border:"1px solid "+T.border,color:T.muted,cursor:"pointer",fontSize:12,fontWeight:600}}>Cancelar</button>
            </div>
          </div>
        </div>}

        <div>
        {}
        {tab==="visao" && <div style={{animation:"fadeIn 0.3s ease"}}>
          {}
          {}
          <HeroNarrative pat={pat} fluxo={fluxo} metP={metP} mes={mes} ano={ano} privateMode={privateMode} />
          {(function() {
            var hoje = new Date();
            var diaHoje = hoje.getDate();
            var mesHoje = hoje.getMonth() + 1;
            var anoHoje = hoje.getFullYear();
            var isCurrentMonth = mesHoje === mes && anoHoje === ano;
            if (!isCurrentMonth) return null;
            var fatProximas = [];
            cardsResumo.forEach(function(c) {
              c.faturas.forEach(function(f) {
                if (!f.paga && f.total > 0) {
                  var dias = Math.ceil((f.vencDate - hoje) / 86400000);
                  if (dias >= 0 && dias <= 3) fatProximas.push({nome:c.nome, dias:dias, valor:f.total});
                }
              });
            });
            var pendHoje = (db.lancamentos||[]).filter(function(l) { return l.mes === mes && l.ano === ano && l.status === "pendente" && !l.virtual && l.data && l.data.slice(8,10) === String(diaHoje).padStart(2,"0"); }).length;
            var wkPend = checklistSemanal.filter(function(x) { return !x.ok; }).length;
            var criticos = als.filter(function(a) { return a.s === "danger"; }).length;
            var temAlgo = fatProximas.length > 0 || pendHoje > 0 || wkPend > 0 || criticos > 0;
            if (!temAlgo) return null;
            return <div className="hud-card glow-cyan magnetic shine-on-hover parallax-3d reveal-on-scroll vv-breath" style={Object.assign({},bx,{marginBottom:14,padding:16,background:"linear-gradient(135deg, rgba(15,25,41,0.45), rgba(6,182,212,0.08))",borderColor:T.cyan+"30"})}>
              <span className="vv-topline" />
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                <span className="live-dot" />
                <div style={{padding:5,borderRadius:8,background:T.cyan+"12",display:"flex",border:"1px solid "+T.cyan+"20"}}><Calendar size={14} color={T.cyan} /></div>
                <div style={{fontFamily:FF.mono,fontSize:11,color:T.cyan,letterSpacing:"0.18em",textTransform:"uppercase"}}>HOJE_</div>
                <div style={{fontSize:13,fontWeight:600,letterSpacing:-0.2}}>{diaHoje} de {MSF[mesHoje-1]}</div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(140px, 1fr))",gap:8}}>
                {fatProximas.length > 0 && <div style={{padding:"10px 12px",borderRadius:12,background:T.red+"08",border:"1px solid "+T.red+"12"}}><div style={{fontSize:11,color:T.red,textTransform:"uppercase",fontWeight:700,marginBottom:4}}>Faturas proximas</div>{fatProximas.map(function(fp,i){return <div key={i} style={{fontSize:12,color:T.muted,marginTop:3}}>{fp.nome}: {fp.dias === 0 ? "HOJE" : fp.dias + " dia(s)"} - {f$(fp.valor)}</div>;})}</div>}
                {pendHoje > 0 && <div style={{padding:"10px 12px",borderRadius:12,background:T.gold+"08",border:"1px solid "+T.gold+"12"}}><div style={{fontSize:11,color:T.gold,textTransform:"uppercase",fontWeight:700,marginBottom:4}}>Pendentes hoje</div><div style={{fontSize:16,fontWeight:900,color:T.gold}}>{pendHoje}</div><div style={{fontSize:11,color:T.dim}}>lançamento(s) para hoje</div></div>}
                {wkPend > 0 && <div style={{padding:"10px 12px",borderRadius:12,background:T.cyan+"08",border:"1px solid "+T.cyan+"12"}}><div style={{fontSize:11,color:T.cyan,textTransform:"uppercase",fontWeight:700,marginBottom:4}}>Checklist semanal</div><div style={{fontSize:16,fontWeight:900,color:T.cyan}}>{wkPend}/{checklistSemanal.length}</div><div style={{fontSize:11,color:T.dim}}>itens pendentes</div></div>}
                {criticos > 0 && <div style={{padding:"10px 12px",borderRadius:12,background:T.red+"08",border:"1px solid "+T.red+"12"}}><div style={{fontSize:11,color:T.red,textTransform:"uppercase",fontWeight:700,marginBottom:4}}>Alertas críticos</div><div style={{fontSize:16,fontWeight:900,color:T.red}}>{criticos}</div><div style={{fontSize:11,color:T.dim}}>requerem atenção</div></div>}
              </div>
            </div>;
          })()}

          {}
          {notifs.length > 0 && <div style={{display:"flex",gap:8,marginBottom:14,overflowX:"auto",paddingBottom:4,scrollbarWidth:"none"}}>
            {notifs.map(function(n,i){var Icon=n.icon;return <div key={i} style={{padding:"8px 14px",borderRadius:12,background:n.cor+"08",border:"1px solid "+n.cor+"15",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
              <div style={{width:28,height:28,borderRadius:8,background:n.cor+"15",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon size={13} color={n.cor} /></div>
              <div style={{fontSize:12,color:T.text,fontWeight:700,whiteSpace:"nowrap"}}>{n.text}</div>
              {n.dias > 0 && <div style={{fontSize:16,fontWeight:900,color:n.cor,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{n.dias}d</div>}
            </div>;})}
          </div>}

          <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:12,marginBottom:14}}>
            <div className="hud-card breathe magnetic parallax-3d reveal-on-scroll" style={Object.assign({},bx,{padding:16,textAlign:"center",minWidth:110,borderColor:healthColor+"30",boxShadow:"0 0 24px "+healthColor+"15, 0 24px 60px -24px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)"})}>
              <div style={Object.assign({},TOP_LINE(healthColor),{opacity:0.6})} />
              <div style={{fontFamily:FF.mono,fontSize:10,color:T.dim,textTransform:"uppercase",letterSpacing:"1.5px",fontWeight:500,marginBottom:8}}>SAUDE_INDEX</div>
              <div style={{position:"relative",width:64,height:64,margin:"0 auto"}}>
                <svg viewBox="0 0 36 36" style={{width:64,height:64,transform:"rotate(-90deg)",filter:"drop-shadow(0 0 6px "+healthColor+"60)"}}>
                  <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
                  <circle cx="18" cy="18" r="14" fill="none" stroke={healthColor} strokeWidth="3" strokeDasharray={String(healthScore*0.88)+" 88"} strokeLinecap="round" />
                </svg>
                <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,fontWeight:500,color:healthColor,fontFamily:FF.mono,fontVariantNumeric:"tabular-nums",letterSpacing:"-0.5px"}}>{healthScore}</div>
              </div>
              <div style={{fontFamily:FF.mono,fontSize:10,fontWeight:500,color:healthColor,marginTop:6,letterSpacing:"0.1em",textTransform:"uppercase"}}>{healthLabel}</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
              {[{l:"Receita",k:"receitaMes",c:T.greenL,cls:"metric-green"},{l:"Despesas",k:"despLancadas",c:T.red,cls:"metric-amber"},{l:"Sobra",k:"sobraPrevista",c:T.green,cls:"metric-green"}].map(function(sp){
                var data = getSparkData(sp.k);
                var maxV = Math.max.apply(null,data.map(function(d){return Math.abs(d.v)}))||1;
                var pts = data.map(function(d,i){return String(i*25+5)+","+String(34-((d.v||0)/maxV)*28)}).join(" ");
                var prevV = data[1] ? data[1].v : 0;
                var lastV = data[2].v;
                var deltaPct = prevV !== 0 ? Math.round((lastV - prevV) / Math.abs(prevV) * 100) : 0;
                return <div key={sp.k} className={"metric-card magnetic shine-on-hover parallax-3d reveal-on-scroll "+sp.cls} style={{padding:"10px 12px",animation:"staggerIn 0.55s cubic-bezier(0.2,0.8,0.2,1) "+(0.1+(["Receita","Despesas","Sobra"].indexOf(sp.l))*0.08)+"s both"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:2}}>
                    <span style={{fontFamily:FF.mono,fontSize:10,color:T.dim,textTransform:"uppercase",letterSpacing:"1.5px"}}>{sp.l}</span>
                    {deltaPct !== 0 && <PulseBadge color={deltaPct >= 0 ? T.green : T.orange} style={{padding:"1px 6px", fontSize:9}}>{deltaPct >= 0 ? "+" : ""}{deltaPct}%</PulseBadge>}
                  </div>
                  <div style={{fontSize:15,fontWeight:600,color:sp.c,fontFamily:FF.mono,fontVariantNumeric:"tabular-nums",letterSpacing:"-0.3px",marginTop:2,filter:"drop-shadow(0 0 8px "+sp.c+"40)"}}><NumberTicker value={data[2].v} format={f$} duration={650}/></div>
                  <svg viewBox="0 0 55 38" style={{width:"100%",height:28,marginTop:4}}>
                    <defs>
                      <linearGradient id={"sparkfill_"+sp.k} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={sp.c} stopOpacity="0.3" /><stop offset="100%" stopColor={sp.c} stopOpacity="0" /></linearGradient>
                    </defs>
                    <polyline points={"5,38 "+pts+" 55,38"} fill={"url(#sparkfill_"+sp.k+")"} />
                    <polyline points={pts} fill="none" stroke={sp.c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    {data.map(function(d,i){return <circle key={i} cx={String(i*25+5)} cy={String(34-((d.v||0)/maxV)*28)} r={i===2?"2.8":"1.8"} fill={sp.c} stroke={i===2?"rgba(255,255,255,0.2)":"none"} strokeWidth="0.5" />})}
                  </svg>
                  <div style={{display:"flex",justifyContent:"space-between",fontFamily:FF.mono,fontSize:9,color:T.dim,marginTop:2,letterSpacing:"0.08em"}}>{data.map(function(d,i){return <span key={i}>{d.m}</span>})}</div>
                </div>;
              })}
            </div>
          </div>

          {/* COMPARATIVO 3 MESES + CONSISTENCIA */}
          <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:12,marginBottom:14}}>
            <div style={bx}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10,display:"flex",alignItems:"center",gap:6}}><BarChart3 size={12} color={T.blue} /> Comparativo 3 meses</div>
              <div style={{display:"grid",gridTemplateColumns:"auto 1fr 1fr 1fr",gap:0,fontSize:12}}>
                <div style={{padding:"4px 8px",fontWeight:700,color:T.dim,borderBottom:"1px solid "+T.border}}></div>
                {comp3m.map(function(m,i){return <div key={i} style={{padding:"4px 8px",textAlign:"right",fontWeight:700,color:i===2?T.cyan:T.dim,borderBottom:"1px solid "+T.border}}>{m.nome}</div>})}
                {[{l:"Receita",k:"receita",c:T.green},{l:"Despesa",k:"despesa",c:T.red},{l:"Sobra",k:"sobra",c:T.green}].map(function(row){
                  return [<div key={row.k+"l"} style={{padding:"6px 8px",fontWeight:600,color:T.muted,borderBottom:"1px solid "+T.border}}>{row.l}</div>].concat(comp3m.map(function(m,i){
                    var val = m[row.k];
                    var prev = i > 0 ? comp3m[i-1][row.k] : 0;
                    var delta = i > 0 && prev !== 0 ? Math.round((val-prev)/Math.abs(prev)*100) : 0;
                    return <div key={row.k+i} style={{padding:"6px 8px",textAlign:"right",fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700,color:row.k==="despesa"?T.red:(val>=0?T.green:T.red),borderBottom:"1px solid "+T.border}}>
                      {fK(val)}{i>0 && delta!==0 && <span style={{fontSize:11,color:delta>0?(row.k==="despesa"?T.red:T.green):(row.k==="despesa"?T.green:T.red),marginLeft:3}}>{delta>0?"+":""}{delta}%</span>}
                    </div>;
                  }));
                })}
              </div>
            </div>
            <div className="hud-card breathe magnetic parallax-3d reveal-on-scroll" style={Object.assign({},bx,{padding:14,textAlign:"center",minWidth:96,borderColor:(consistency.score>=60?T.green:consistency.score>=30?T.gold:T.red)+"30"})}>
              <div style={Object.assign({},TOP_LINE(consistency.score>=60?T.green:consistency.score>=30?T.gold:T.red),{opacity:0.6})} />
              <div style={{fontFamily:FF.mono,fontSize:10,color:T.dim,textTransform:"uppercase",letterSpacing:"1.5px",fontWeight:500,marginBottom:6}}>CONSISTENCIA_</div>
              <div style={{position:"relative",width:54,height:54,margin:"0 auto"}}>
                <svg viewBox="0 0 36 36" style={{width:54,height:54,transform:"rotate(-90deg)",filter:"drop-shadow(0 0 4px "+(consistency.score>=60?T.green:consistency.score>=30?T.gold:T.red)+"50)"}}>
                  <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
                  <circle cx="18" cy="18" r="14" fill="none" stroke={consistency.score>=60?T.green:consistency.score>=30?T.gold:T.red} strokeWidth="3" strokeDasharray={String(consistency.score*0.88)+" 88"} strokeLinecap="round" />
                </svg>
                <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:500,color:consistency.score>=60?T.green:consistency.score>=30?T.gold:T.red,fontFamily:FF.mono,fontVariantNumeric:"tabular-nums",letterSpacing:"-0.3px"}}>{consistency.score}</div>
              </div>
              <div style={{fontFamily:FF.mono,fontSize:10,color:T.dim,marginTop:5,letterSpacing:"0.08em"}}>{consistency.diasAtivos}/{consistency.diasPassados} dias</div>
              {consistency.diasSemLanc >= 2 && <div className="tag-mono tag-dn" style={{marginTop:5,padding:"2px 6px",fontSize:9}}>{consistency.diasSemLanc}d sem lanc</div>}
            </div>
          </div>

          {}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(320px, 1fr))",gap:12,marginBottom:18}}>
          <div className="hud-card border-flow magnetic shine-on-hover parallax-3d reveal-on-scroll" style={Object.assign({},bx,{padding:22,background:"linear-gradient(135deg, rgba(10,10,18,0.45), rgba(14,18,36,0.25))",position:"relative",overflow:"hidden",borderColor:ratingColor+"30",boxShadow:"0 24px 60px -24px rgba(0,0,0,0.6), 0 0 50px -20px "+ratingColor+"50, inset 0 1px 0 rgba(255,255,255,0.06)"})}>
            <div style={Object.assign({},TOP_LINE(ratingColor),{opacity:0.7})} />
            <div className="scan-overlay" />
            <div style={{position:"absolute",inset:0,pointerEvents:"none",background:"radial-gradient(ellipse at 0% 0%, rgba(0,245,160,0.08), transparent 50%), radial-gradient(ellipse at 100% 100%, rgba(168,85,247,0.06), transparent 50%)"}} />
            <div style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"center",marginBottom:16,position:"relative",zIndex:1}}>
              <div style={{flex:1}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <span className="live-dot" style={{background:ratingColor,boxShadow:"0 0 8px "+ratingColor}} />
                  <div style={{fontFamily:FF.mono,fontSize:10,color:ratingColor,textTransform:"uppercase",letterSpacing:"1.8px",fontWeight:500}}>COCKPIT_DO_MES</div>
                </div>
                <div style={{fontSize:12,color:T.muted,marginTop:8,lineHeight:1.5}}>Score interno orientativo. Foco: <span style={{color:T.cyan,fontFamily:FF.mono}}>{focoEstrategico.bancoFoco}</span>.</div>
                <div style={{display:"flex",alignItems:"baseline",gap:8,marginTop:10}}>
                  <div style={{fontSize:24,fontWeight:500,color:ratingDeltaColor,fontFamily:FF.mono,fontVariantNumeric:"tabular-nums",letterSpacing:"-0.5px",filter:"drop-shadow(0 0 8px "+ratingDeltaColor+"50)"}}>{ratingDelta>=0?"+":""}{ratingDelta}</div>
                  <span style={{fontFamily:FF.mono,fontSize:10,color:T.dim,letterSpacing:"0.1em",textTransform:"uppercase"}}>pts vs anterior</span>
                </div>
              </div>
              <ScoreGauge value={ratingScore} max={100} color={ratingColor} />
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:6,position:"relative",zIndex:1}}>
              {[{l:"Score Santander",v:planoSantander.score+"/100",c:"#FF453A"},{l:"Score Itaú",v:planoItau.score+"/100",c:"#FF9F0A"},{l:"Sobra realizada",v:f$(fluxo.sobraRealizada),c:fluxo.sobraRealizada>=0?T.green:T.red},{l:"Até salário",v:f$(fluxo.ateSalario),c:fluxo.ateSalario>=0?T.green:T.red},{l:"Fatura do mês",v:f$(totalFaturaAtual),c:T.blue},{l:"Críticos",v:String(focoEstrategico.criticos),c:focoEstrategico.criticos>0?T.red:T.green}].map(function(x,i){return <div key={i} className="hover-tilt magnetic shine-on-hover" style={Object.assign({},mc,{borderColor:x.c+"22",position:"relative",overflow:"hidden",animation:"staggerIn 0.55s cubic-bezier(0.2,0.8,0.2,1) "+(i*0.06)+"s both"})}><div style={{position:"absolute",top:0,left:0,right:0,height:1,background:"linear-gradient(90deg,transparent,"+x.c+",transparent)",opacity:0.6,animation:"borderFlow 6s linear infinite",backgroundSize:"300% 100%"}} /><div style={{fontFamily:FF.mono,fontSize:9,color:T.dim,textTransform:"uppercase",marginBottom:4,letterSpacing:"1.4px",fontWeight:500}}>{x.l}</div><div style={{fontSize:15,fontWeight:500,fontFamily:FF.mono,fontVariantNumeric:"tabular-nums",letterSpacing:"-0.3px",color:x.c,filter:"drop-shadow(0 0 6px "+x.c+"40)"}}>{x.v}</div></div>;})}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(140px, 1fr))",gap:6,marginTop:8,position:"relative",zIndex:1}}>
              <div style={mc}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",marginBottom:4,letterSpacing:0.5,fontWeight:700}}>Banco foco</div><div style={{display:"flex",alignItems:"center",gap:6}}><div style={{fontSize:15,fontWeight:800}}>{focoEstrategico.bancoFoco}</div><select value={bancoFocoManual} onChange={function(e){setBancoFoco(e.target.value)}} style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:6,padding:"3px 5px",color:T.muted,fontSize:11,outline:"none",cursor:"pointer"}}><option value="">Auto</option><option value="Santander">Santander</option><option value="Itaú">Itaú</option></select></div></div>
              <div style={mc}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",marginBottom:4,letterSpacing:0.5,fontWeight:700}}>Acao principal</div><div style={{fontSize:12,fontWeight:600,color:T.text,lineHeight:1.4}}>{focoEstrategico.acaoPrincipal}</div></div>
              <div style={mc}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",marginBottom:4,letterSpacing:0.5,fontWeight:700}}>Risco</div><div style={{fontSize:12,fontWeight:600,color:focoEstrategico.criticos>0?T.red:T.gold,lineHeight:1.4}}>{focoEstrategico.riscoPrincipal}</div></div>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr",gap:14}}>
            <div style={Object.assign({},bx,{padding:18})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}><div style={{fontSize:13,fontWeight:900,letterSpacing:-0.2}}>Visão executiva mensal</div><Bd color={focoEstrategico.cardFoco ? getCardStatusColor(focoEstrategico.cardFoco.statusEstr) : T.blue}>{focoEstrategico.cardFoco ? (focoEstrategico.cardFoco.nome || "Cartão foco") : "Sem cartão foco"}</Bd></div>
              <div style={{display:"flex",flexDirection:"column",gap:9,fontSize:12,color:T.muted}}>
                <div style={{display:"flex",justifyContent:"space-between",padding:"8px 10px",borderRadius:10,background:"rgba(255,255,255,0.03)"}}><span>Meta do mes</span><span style={{color:T.text,fontWeight:700}}>{focoEstrategico.metaMes}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",padding:"8px 10px",borderRadius:10,background:"rgba(255,255,255,0.03)"}}><span>Futuro em cartoes</span><span style={{color:T.cyan,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(totalProxFatura + totalSegundaFatura)}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",padding:"8px 10px",borderRadius:10,background:"rgba(255,255,255,0.03)"}}><span>Limite livre real</span><span style={{color:T.green,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(totalLivreReal)}</span></div>
                <div style={{padding:"10px 12px",borderRadius:10,background:T.gold+"08",border:"1px solid "+T.gold+"12",fontSize:12}}><strong style={{color:T.gold}}>Janela estrategica:</strong> <span style={{color:T.muted}}>{focoEstrategico.planoFoco.janelaIdeal}</span></div>
              </div>
            </div>
            <div style={Object.assign({},bx,{padding:18})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}><div style={{fontSize:13,fontWeight:900,letterSpacing:-0.2}}>Checklist semanal</div><span style={{fontSize:11,color:T.dim}}>{checklistSemanal.filter(function(x){return x.ok}).length}/{checklistSemanal.length}</span></div>
              <div style={{display:"flex",flexDirection:"column",gap:7}}>{checklistSemanal.slice(0,4).map(function(item){return <div key={item.id} onClick={function(){togWeeklyTask(item.id)}} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:12,background:item.ok?"rgba(16,185,129,0.06)":"rgba(255,255,255,0.02)",border:"1px solid "+(item.ok?"rgba(16,185,129,0.12)":"rgba(255,255,255,0.05)"),cursor:"pointer"}}><div style={{width:18,height:18,borderRadius:5,background:item.ok?T.green:"transparent",border:item.ok?"none":"2px solid rgba(255,255,255,0.12)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{item.ok && <Check size={11} color="#fff" strokeWidth={3} />}</div><span style={{fontSize:12,color:item.ok?T.text:T.muted,fontWeight:600,flex:1}}>{item.label}</span></div>;})}</div>
            </div>
          </div>
        </div>

          {}
          <div onClick={function(){setSaudeOpen(!saudeOpen)}} style={{marginBottom:16,padding:24,borderRadius:20,background:"linear-gradient(135deg, rgba(10,14,28,0.68), rgba(14,18,36,0.48))",border:"1px solid "+saude.color+"38",position:"relative",overflow:"hidden",cursor:"pointer",backdropFilter:"blur(24px) saturate(1.6)",WebkitBackdropFilter:"blur(24px) saturate(1.6)",boxShadow:"0 24px 60px -24px rgba(0,0,0,0.55), 0 0 40px -16px "+saude.color+", inset 0 1px 0 rgba(255,255,255,0.06)",transition:"all 0.3s"}}>
            <div style={{position:"absolute",top:0,left:"15%",right:"15%",height:1,background:"linear-gradient(90deg, transparent, "+saude.color+"BB, transparent)",pointerEvents:"none"}} />
            <div style={{position:"absolute",inset:0,pointerEvents:"none",background:"radial-gradient(500px circle at 0% 50%, "+saude.color+"18, transparent 55%)"}} />
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",position:"relative",zIndex:1,gap:12}}>
              <div style={{display:"flex",alignItems:"center",gap:16,minWidth:0,flex:1}}>
                <div style={{width:56,height:56,borderRadius:16,background:"linear-gradient(135deg, "+saude.color+"2E, "+saude.color+"12)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,color:saude.color,boxShadow:"0 0 30px -8px "+saude.color+", inset 0 1px 0 rgba(255,255,255,0.10)",border:"1px solid "+saude.color+"44",flexShrink:0}}>{saude.emoji}</div>
                <div style={{minWidth:0}}>
                  <div style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.dim,textTransform:"uppercase",letterSpacing:"0.22em",marginBottom:4}}>◇ saúde financeira</div>
                  <div className="serif-title" style={{fontSize:24,fontWeight:400,color:saude.color,lineHeight:1.05,textShadow:"0 0 18px "+saude.color+"55"}}>{saude.label}</div>
                  <div style={{fontFamily:"'Geist Mono',monospace",fontSize:12,color:T.muted,marginTop:4,letterSpacing:"0.08em"}}>score <span className="mono-num" style={{color:T.text,fontWeight:500}}>{saude.score}/100</span></div>
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:12,flexShrink:0}}>
                <div style={{textAlign:"right",display:"flex",flexDirection:"column",gap:3}}>
                  <div style={{fontFamily:"'Geist Mono',monospace",fontSize:12,color:T.dim}}>fixas <span style={{color:T.muted,fontWeight:500}}>{pct(saude.pctFixas)}</span></div>
                  <div style={{fontFamily:"'Geist Mono',monospace",fontSize:12,color:T.dim}}>parc <span style={{color:T.muted,fontWeight:500}}>{pct(saude.pctDiv)}</span></div>
                  <div style={{fontFamily:"'Geist Mono',monospace",fontSize:12,color:saude.color,fontWeight:500}}>sobra <span style={{fontWeight:600}}>{pct(saude.pctSobra)}</span></div>
                </div>
                <div style={{width:28,height:28,borderRadius:10,background:"rgba(255,255,255,0.04)",display:"flex",alignItems:"center",justifyContent:"center",border:"1px solid rgba(255,255,255,0.08)",transform:saudeOpen?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.3s cubic-bezier(0.2,0.8,0.2,1)"}}><ChevronDown size={14} color={saude.color} /></div>
              </div>
            </div>
            <div style={{marginTop:14,position:"relative",zIndex:1}}><PB value={saude.score} max={100} color={saude.color} h={7} /></div>
            {saudeOpen && saude.items && saude.items.length > 0 && <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:6,position:"relative",zIndex:1}}>
              {saude.items.map(function(item, i) {
                var ic = item.s === "ok" ? T.green : item.s === "warning" ? T.gold : T.red;
                var sym = item.s === "ok" ? "+" : item.s === "warning" ? "!" : "✕";
                return <div key={i} style={{display:"flex",gap:10,alignItems:"center",padding:"9px 12px",borderRadius:12,background:ic+"06",border:"1px solid "+ic+"12"}}>
                  <div style={{width:20,height:20,borderRadius:6,background:ic+"18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:900,color:ic,flexShrink:0}}>{sym}</div>
                  <span style={{fontSize:12,color:T.muted}}>{item.t}</span>
                </div>;
              })}
              <div style={{fontSize:11,color:T.dim,textAlign:"center",marginTop:4}}>Score interno orientativo baseado em indicadores observaveis</div>
            </div>}
          </div>

          {/* HERO SHOWCASE: Patrim. Liquido gigante */}
          <div className="reveal" style={{position:"relative",display:"grid",gridTemplateColumns:"1fr auto",alignItems:"center",gap:24,padding:"30px 28px",borderRadius:22,overflow:"hidden",background:"radial-gradient(600px circle at 0% 0%, rgba(0,245,212,0.10), transparent 55%), radial-gradient(500px circle at 100% 100%, rgba(123,76,255,0.10), transparent 55%), linear-gradient(135deg, rgba(10,14,28,0.68), rgba(14,18,36,0.48))",border:"1px solid rgba(255,255,255,0.08)",boxShadow:"0 30px 80px -30px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)",marginBottom:18,transition:"opacity 0.6s cubic-bezier(0.2,0.8,0.2,1), transform 0.6s cubic-bezier(0.2,0.8,0.2,1)"}}>
            <div style={{minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:10,fontFamily:"'Geist Mono',monospace",fontSize:12,color:T.dim,letterSpacing:"0.22em",textTransform:"uppercase"}}>
                <span style={{display:"inline-flex",alignItems:"center",gap:6,color:T.cyan}}>
                  <span style={{width:6,height:6,borderRadius:"50%",background:T.cyan,boxShadow:"0 0 10px "+T.cyan,animation:"pulse 1.6s ease-in-out infinite"}} />
                  live · {MSF[mes-1]}
                </span>
                <span style={{opacity:0.3}}>|</span>
                <span>patrim_liq</span>
              </div>
              <div style={{marginTop:14,display:"flex",alignItems:"baseline",gap:12,fontFamily:"'Space Grotesk',sans-serif",fontWeight:300}}>
                <span style={{fontSize:22,color:T.muted}}>R$</span>
                <span key={mes+"-"+ano} className="gradient-num" style={{fontSize:"clamp(40px,9vw,64px)",letterSpacing:"-0.035em",lineHeight:1,fontWeight:300,display:"inline-block"}}>{privateMode?"•••.•••":<AnimNum value={pat.liq||0} duration={1100} />}</span>
              </div>
              <div style={{marginTop:16,display:"flex",flexWrap:"wrap",gap:8}}>
                {deltaReceita !== undefined && deltaReceita !== 0 && <span className={"chip-pill "+(deltaReceita>=0?"chip-up":"chip-dn")}>{deltaReceita>=0?"↑":"↓"} receita {f$(Math.abs(deltaReceita))}</span>}
                {deltaDespesas !== undefined && deltaDespesas !== 0 && <span className={"chip-pill "+(deltaDespesas<=0?"chip-up":"chip-dn")}>{deltaDespesas>=0?"↑":"↓"} despesa {f$(Math.abs(deltaDespesas))}</span>}
                <span className="chip-pill">{lancEx.filter(function(l){return l.mes===mes&&l.ano===ano}).length} lanc.</span>
              </div>
            </div>
            <div style={{position:"relative",minWidth:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <div style={{position:"absolute",inset:"-20px",borderRadius:"50%",border:"1px solid rgba(0,245,212,0.15)",animation:"orb 3s ease-in-out infinite"}} />
              <div style={{position:"absolute",inset:"-40px",borderRadius:"50%",border:"1px solid rgba(0,245,212,0.08)",animation:"orb 3s ease-in-out infinite 1.5s"}} />
              <RingScore size={148} stroke={8} center={String(saude.score)} rings={[
                {value: saude.score, color: saude.color, color2: T.cyan},
                {value: Math.max(0, saude.pctSobra), color: T.green, color2: T.cyan},
                {value: Math.max(0, Math.min(100, (saude.mesesReserva||0) / 6 * 100)), color: T.blue, color2: T.purple}
              ]} />
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(155px,1fr))",gap:14,marginBottom:18}}>
            {[{i:Landmark,l:"patrim. liq.",vn:pat.liq,c:T.cyan,k:"Λ"},{i:Wallet,l:"saldo contas",vn:pat.sc,c:T.blue,k:"○"},{i:PiggyBank,l:"investido",vn:pat.inv,c:T.purple,k:"◇"},{i:TrendingUp,l:"receitas",vn:pv.receitaMes,c:T.green,d:deltaReceita,k:"↑"},{i:TrendingDown,l:"despesas",vn:pv.despLancadas,c:T.orange,d:deltaDespesas,inv:true,k:"↓"},{i:DollarSign,l:"sobra realizada",vn:pv.sobraPrevista,c:pv.sobraPrevista>=0?T.green:T.orange,d:deltaSobra,k:"Δ"}].map(function(s,i) {
              var hasDelta = s.d !== undefined && s.d !== 0;
              var dPos = s.inv ? s.d <= 0 : s.d >= 0;
              return <div key={i} className="reveal" style={{position:"relative",padding:"20px 22px 18px",borderRadius:18,overflow:"hidden",background:"linear-gradient(135deg, rgba(10,14,28,0.62), rgba(14,18,36,0.42))",border:"1px solid rgba(255,255,255,0.08)",boxShadow:"0 18px 50px -20px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",backdropFilter:"blur(24px) saturate(1.6)",WebkitBackdropFilter:"blur(24px) saturate(1.6)",transition:"transform .3s, box-shadow .3s, opacity 0.6s cubic-bezier(0.2,0.8,0.2,1)",cursor:"default",transitionDelay:(i*60)+"ms"}}>
                <div style={{position:"absolute",top:-30,right:-20,width:100,height:100,borderRadius:"50%",background:s.c+"18",filter:"blur(30px)",pointerEvents:"none"}} />
                <div style={{display:"flex",alignItems:"center",gap:8,position:"relative",zIndex:2}}>
                  <span style={{fontFamily:"'Geist Mono',monospace",fontSize:13,color:s.c,textShadow:"0 0 10px "+s.c+"60"}}>{s.k}</span>
                  <span style={{fontFamily:"'Geist Mono',monospace",fontSize:12,color:T.dim,letterSpacing:"0.2em",textTransform:"uppercase"}}>{s.l}</span>
                </div>
                <div className="gradient-num" style={{marginTop:12,fontFamily:"'Space Grotesk',sans-serif",fontWeight:400,fontSize:26,letterSpacing:"-0.025em",lineHeight:1,position:"relative",zIndex:2}}>{privateMode?"•••":<span>R$ <AnimNum value={s.vn||0} duration={1000 + (i*80)} /></span>}</div>
                {hasDelta && <div style={{marginTop:14,display:"flex",alignItems:"center",gap:6,position:"relative",zIndex:2}}>
                  <span style={{fontFamily:"'Geist Mono',monospace",fontSize:12,color:dPos?T.green:T.orange}}>{dPos?"▲":"▼"} {f$(Math.abs(s.d))}</span>
                  <span style={{fontFamily:"'Geist Mono',monospace",fontSize:12,color:T.dim}}>vs mês ant.</span>
                </div>}
              </div>;
            })}
          </div>

          <div style={Object.assign({},bx,{marginBottom:18,background:"linear-gradient(135deg, rgba(15,25,41,0.97), rgba(59,130,246,0.04))",position:"relative",overflow:"hidden"})}>
            <div style={{position:"absolute",inset:0,pointerEvents:"none",background:"radial-gradient(ellipse at 100% 50%, rgba(59,130,246,0.06), transparent 50%)"}} />
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8,position:"relative",zIndex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:7}}><div style={{padding:5,borderRadius:8,background:T.blue+"12",display:"flex",border:"1px solid "+T.blue+"10"}}><CreditCard size={14} color={T.blue} /></div><span style={{fontSize:14,fontWeight:900,letterSpacing:-0.2}}>Fluxo por forma de pagamento</span></div>
              <Bd color={fluxo.sobraRealizada>=0?T.green:T.red}>Sobra realizada {f$(fluxo.sobraRealizada)}</Bd>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(125px,1fr))",gap:8,position:"relative",zIndex:1}}>
              {[{l:"Receitas",v:fluxo.receita,c:T.greenL},{l:"PIX / débito",v:fluxo.pix,c:T.orange},{l:"Fatura vence",v:fluxo.faturaDoMes,c:T.purple},{l:"Sobra realizada",v:fluxo.sobraRealizada,c:fluxo.sobraRealizada>=0?T.green:T.red},{l:"Até salário",v:fluxo.ateSalario,c:fluxo.ateSalario>=0?T.green:T.red}].map(function(x,i){return <div key={i} style={{padding:"11px 13px",borderRadius:14,background:"rgba(255,255,255,0.03)",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",marginBottom:4,letterSpacing:0.3,fontWeight:700}}>{x.l}</div><div style={{fontSize:14,fontWeight:900,fontFamily:"'Inter', monospace",color:x.c}}>{f$(x.v)}</div></div>;})}
              <div style={{padding:"11px 13px",borderRadius:14,background:"rgba(255,255,255,0.03)",textAlign:"center",border:"1px solid "+T.cyan+"15"}}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",marginBottom:4,letterSpacing:0.3,fontWeight:700}}>Invest. fixo</div><EV value={fluxo.investFixo} onChange={updInvestFixo} /></div>
            </div>
            <div style={{marginTop:12,padding:"10px 14px",borderRadius:12,background:"rgba(255,255,255,0.025)",fontSize:12,color:T.dim,position:"relative",zIndex:1,border:"1px solid rgba(255,255,255,0.03)"}}>Receitas ({f$(fluxo.receita)}) - PIX ({f$(fluxo.pix)}) - Fatura ({f$(fluxo.faturaDoMes)}) = Sobra {f$(fluxo.sobraRealizada)} | Até salário = Sobra - Invest. {f$(fluxo.investFixo)} = {f$(fluxo.ateSalario)}</div>
          </div>

          <button onClick={function(){setModal({type:"lanc",title:"Novo Lançamento",data:{}})}} className="ripple-host micro-lift" style={{display:"flex",alignItems:"center",gap:10,padding:"14px 20px",borderRadius:14,background:"linear-gradient(135deg, rgba(0,245,212,0.16), rgba(0,194,255,0.10))",border:"1px solid rgba(0,245,212,0.30)",color:T.text,cursor:"pointer",fontSize:13,fontWeight:500,width:"100%",justifyContent:"center",marginBottom:18,boxShadow:"0 0 30px -10px "+T.cyan+", inset 0 1px 0 rgba(255,255,255,0.06)",letterSpacing:"-0.005em",fontFamily:"'Space Grotesk',sans-serif",transition:"all 0.25s cubic-bezier(0.2,0.8,0.2,1)"}}><Plus size={16} color={T.cyan} style={{filter:"drop-shadow(0 0 6px "+T.cyan+")"}} /> Novo lançamento</button>

          {}
          <div style={Object.assign({},bx,{marginBottom:16,background:"linear-gradient(135deg,"+T.card+","+T.cyan+"04)",boxShadow:"0 0 20px rgba(6,182,212,0.04)"})}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:12}}><Activity size={14} color={T.cyan} /><span style={{fontSize:13,fontWeight:700}}>Previsão do Mes: {MSF[mes-1]}</span></div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:8}}>
              {[{l:"Receita",v:pv.receitaMes,c:T.greenL},{l:"Desp. Lancadas",v:pv.despLancadas,c:T.red},{l:"Total saidas",v:pv.despTotalMes,c:T.orange},{l:"Sobra",v:pv.sobraPrevista,c:pv.sobraPrevista>=0?T.green:T.red},{l:"Invest. fixo",v:pv.investFixo,c:T.cyan},{l:"Até salário",v:pv.aindaPodeGastar,c:pv.aindaPodeGastar>=0?T.green:T.red}].map(function(x,i) {
                return <div key={i} style={mc2}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",marginBottom:3}}>{x.l}</div><div style={{fontSize:13,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",color:x.c}}>{f$(x.v)}</div></div>;
              })}
            </div>
            <div style={{marginTop:10,padding:"8px 12px",borderRadius:8,background:T.cardAlt,fontSize:12,color:T.muted}}>
              Sobra = Receita ({f$(pv.receitaMes)}) - Lançamentos ({f$(pv.despLancadas)}) = {f$(pv.sobraPrevista)} | Até salário = Sobra - Invest. {f$(pv.investFixo)} = {f$(pv.aindaPodeGastar)}
            </div>
            <div style={{marginTop:10}}><PB value={pv.despTotalMes} max={pv.receitaMes} color={pv.sobraPrevista>=0?T.cyan:T.red} h={8} /></div>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:11,color:T.dim}}><span>Comprometido: {pct(pv.despTotalMes/(pv.receitaMes||1)*100)} da receita</span><span>Sobra: {f$(pv.sobraPrevista)}</span></div>
          </div>

          {}
          <div style={Object.assign({},bx,{marginBottom:16,background:"linear-gradient(135deg,"+T.card+","+T.purple+"06)"})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{padding:4,borderRadius:6,background:T.purple+"15",display:"flex"}}><CreditCard size={13} color={T.purple} /></div><span style={{fontSize:13,fontWeight:700}}>Assinaturas</span></div>
              <div style={{fontSize:18,fontWeight:800,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",color:T.purple}}>{f$(totalAssin)}</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:6}}>
              {assin.map(function(l,i){return <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 10px",borderRadius:8,background:T.cardAlt,fontSize:12}}><span style={{color:T.muted}}>{l.desc}</span><span style={{fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:600,color:T.purple}}>{f$(l.valor)}</span></div>})}
            </div>
            <div style={{marginTop:8,fontSize:12,color:T.dim}}>{assin.length} assinaturas - {res.rc>0?pct(totalAssin/res.rc*100):"--"} da receita</div>
          </div>

          {}
          {(function() {
            var fixasPagas = fixas.filter(function(l){return l.status==="pago"}).length;
            var fixasTotal = fixas.length;
            var fixasPctPaga = fixasTotal > 0 ? (fixasPagas/fixasTotal)*100 : 0;
            return <div style={Object.assign({},bx,{marginBottom:16,background:"linear-gradient(135deg,"+T.card+","+T.cyan+"06)"})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{padding:4,borderRadius:6,background:T.cyan+"15",display:"flex"}}><Shield size={13} color={T.cyan} /></div><span style={{fontSize:13,fontWeight:700}}>Despesas Fixas</span></div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <button onClick={marcarFixasPagas} style={{padding:"5px 10px",borderRadius:8,background:T.green+"12",border:"1px solid "+T.green+"25",color:T.green,cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:4}}><Check size={11} /> Pagar todas</button>
                <div style={{fontSize:18,fontWeight:800,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",color:T.cyan}}>{f$(totalFixas)}</div>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <PB value={fixasPagas} max={fixasTotal||1} color={T.green} h={5} />
              <span style={{fontSize:12,fontWeight:800,color:fixasPagas===fixasTotal?T.green:T.gold,whiteSpace:"nowrap"}}>{fixasPagas}/{fixasTotal}</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:5}}>
              {fixas.slice().sort(function(a,b){return b.valor-a.valor}).map(function(l,i){var pg=l.status==="pago";return <div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"6px 10px",borderRadius:8,background:pg?T.green+"06":T.cardAlt,border:"1px solid "+(pg?T.green+"12":"transparent"),fontSize:12}}>
                <div style={{width:7,height:7,borderRadius:4,background:pg?T.green:T.gold,flexShrink:0,boxShadow:"0 0 4px "+(pg?T.green:T.gold)+"40"}} />
                <span style={{flex:1,color:pg?T.dim:T.muted,textDecoration:pg?"line-through":"none"}}>{l.desc}</span>
                <span style={{fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:600,color:pg?T.dim:T.text}}>{f$(l.valor)}</span>
              </div>})}
            </div>
            <div style={{marginTop:10,padding:"10px 14px",borderRadius:10,background:sobraFixas>=0?T.green+"08":T.red+"08",border:"1px solid "+(sobraFixas>=0?T.green:T.red)+"15",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:12,color:T.muted}}>Receita {f$(res.rc)} - Fixas {f$(totalFixas)} =</span>
              <span style={{fontSize:16,fontWeight:800,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",color:sobraFixas>=0?T.green:T.red}}>{f$(sobraFixas)}</span>
            </div>
          </div>;
          })()}

          {}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:12}}>
            <div style={bx}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}><div style={{fontSize:12,fontWeight:700}}>Gastos por Categoria</div>{pieFilter && <button onClick={function(){setPieFilter("");setTab("lanc");setBusca(pieFilter)}} style={{padding:"3px 8px",borderRadius:6,background:T.cyan+"12",border:"1px solid "+T.cyan+"20",color:T.cyan,cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:3}}><Search size={9} /> Ver "{pieFilter}"</button>}</div>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:130,height:130,position:"relative"}}>
                  <div style={{position:"absolute",inset:0,borderRadius:"50%",background:"radial-gradient(circle, "+T.cyan+"12 0%, transparent 60%)",pointerEvents:"none",animation:"pulseRing 3s ease-in-out infinite"}} />
                  <ResponsiveContainer><PieChart><Pie data={gPie} dataKey="value" cx="50%" cy="50%" innerRadius={38} outerRadius={58} paddingAngle={2} strokeWidth={0} onClick={function(d){if(d&&d.name){setPieFilter(d.name)}}} style={{cursor:"pointer",filter:"drop-shadow(0 0 8px "+T.cyan+"40)"}}>{gPie.map(function(g,i){var color=g.cor||PC[i%PC.length];return <Cell key={i} fill={color} stroke={pieFilter===g.name?T.text:color+"80"} strokeWidth={pieFilter===g.name?3:0.5} style={{filter:"drop-shadow(0 0 4px "+color+"60)"}} />})}</Pie><Tooltip content={<CustomTooltip />} /></PieChart></ResponsiveContainer>
                </div>
                <div style={{flex:1}}>{gPie.slice(0,7).map(function(g,i){return <div key={i} onClick={function(){setPieFilter(pieFilter===g.name?"":g.name);if(pieFilter!==g.name){setTab("lanc");setBusca(g.name)}}} style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:12,cursor:"pointer",padding:"3px 6px",borderRadius:6,background:pieFilter===g.name?(g.cor||T.cyan)+"12":"transparent",transition:"background 0.2s"}}><div style={{display:"flex",alignItems:"center",gap:5}}><span style={{fontSize:12}}>{g.emoji||"📦"}</span><span style={{color:pieFilter===g.name?T.text:T.muted,fontWeight:pieFilter===g.name?700:400}}>{g.name}</span></div><span style={{fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700,color:g.cor||T.text}}>{f$(g.value)}</span></div>})}</div>
              </div>
            </div>
            <div style={bx}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}><span style={{fontSize:13,fontWeight:800}}>Contas</span><button onClick={function(){setModal({type:"conta",title:"Nova Conta",data:{}})}} style={{background:"none",border:"none",cursor:"pointer",color:T.green,fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:3}}><Plus size={12} />Nova</button></div>
              {db.contas.map(function(c){
                var bk = inferBankKey(c.nome);
                var bp = BANK_PRESETS[bk] || BANK_PRESETS.custom;
                var th = getBankTheme(bk);
                var saldoPositivo = (c.saldo || 0) >= 0;
                return <div key={c.id} style={{padding:0,borderRadius:16,marginBottom:10,position:"relative",overflow:"hidden",border:"1px solid "+th.accent+"25",boxShadow:"0 6px 20px "+th.accent+"12, 0 0 0 1px rgba(255,255,255,0.03)"}}>
                  <div style={{position:"absolute",inset:0,background:"linear-gradient(145deg, "+th.accent+"0A, rgba(2,2,8,0.96) 40%, "+th.accent2+"08)",pointerEvents:"none"}} />
                  <div style={{position:"absolute",top:-20,right:-20,width:100,height:100,borderRadius:"50%",background:"radial-gradient(circle, "+th.accent+"12, transparent 70%)",pointerEvents:"none"}} />
                  <div style={{position:"relative",zIndex:1,padding:"14px 16px 12px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
                      <BankMark card={{bankKey:bk,nome:c.nome}} size={38} />
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:12,fontWeight:800,color:T.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{c.nome}</div>
                        <div style={{fontSize:11,color:th.accent,fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginTop:2}}>{bp.label}</div>
                      </div>
                      <IBtn icon={Edit3} onClick={function(){setModal({type:"conta",title:"Editar",data:c})}} />
                    </div>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <div style={{flex:1}}><EV value={c.saldo} onChange={function(v){updConta(c.id,v)}} large /></div>
                      <div style={{width:8,height:8,borderRadius:4,background:saldoPositivo?T.green:T.red,boxShadow:"0 0 8px "+(saldoPositivo?T.green:T.red)+"60",flexShrink:0,marginLeft:8}} />
                    </div>
                  </div>
                  <div style={{height:3,background:"linear-gradient(90deg, "+th.accent+", "+th.accent2+")",opacity:0.7}} />
                </div>;
              })}
            </div>
          </div>

          {}
          {evolucao.length > 0 && <div style={Object.assign({},bx,{marginTop:12})}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}><TrendingUp size={14} color={T.green} /><span style={{fontSize:13,fontWeight:700}}>Evolucao Patrimonial {ano}</span></div>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={evolucao}>
                <defs><linearGradient id="gAcum" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={T.green} stopOpacity={0.3} /><stop offset="95%" stopColor={T.green} stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="2 6" stroke={T.cyan+"15"} vertical={false} />
                <XAxis dataKey="nome" tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"20"}} tickLine={false} />
                <YAxis tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"20"}} tickLine={false} tickFormatter={fK} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="acum" name="Acumulado" stroke={T.green} fill="url(#gAcum)" strokeWidth={2} style={{filter:"drop-shadow(0 0 8px "+T.green+"70)"}} />
                <Area type="monotone" dataKey="sobra" name="Sobra/mês" stroke={T.cyan} fill="none" strokeWidth={1.5} dot={{r:3,fill:T.cyan,stroke:T.cyan,strokeWidth:1,style:{filter:"drop-shadow(0 0 4px "+T.cyan+"80)"}}} strokeDasharray="4 4" style={{filter:"drop-shadow(0 0 4px "+T.cyan+"70)"}} />
              </AreaChart>
            </ResponsiveContainer>
            <div style={{display:"flex",justifyContent:"space-around",marginTop:8,fontSize:12}}>
              <div style={{textAlign:"center"}}><div style={{color:T.dim}}>Acumulado</div><div style={{color:T.green,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontSize:16}}>{f$(evolucao.length>0?evolucao[evolucao.length-1].acum:0)}</div></div>
              <div style={{textAlign:"center"}}><div style={{color:T.dim}}>Melhor mes</div><div style={{color:T.cyan,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontSize:16}}>{f$(Math.max.apply(null, evolucao.map(function(e){return e.sobra})))}</div></div>
            </div>
          </div>}
        </div>}
        {tab==="anual" && (function(){
          var totalRecAnual = visAnual.reduce(function(s,m){return s+m.rc},0);
          var totalDespAnual = visAnual.reduce(function(s,m){return s+m.dp},0);
          var saldoAnual = totalRecAnual - totalDespAnual;
          var pctComprAnual = totalRecAnual > 0 ? Math.round(totalDespAnual/totalRecAnual*100) : 0;
          var mesesComDados = visAnual.filter(function(m){return m.temDados}).length;
          var recMedia = mesesComDados > 0 ? totalRecAnual / mesesComDados : 0;
          var despMedia = mesesComDados > 0 ? totalDespAnual / mesesComDados : 0;
          var sobraMedia = recMedia - despMedia;

          // Dados para gráfico com linha ideal
          var chartData = visAnual.map(function(m){
            var ideal70 = Math.round(m.rc * 0.70);
            var ideal80 = Math.round(m.rc * 0.80);
            var ratio = m.rc > 0 ? Math.round(m.dp / m.rc * 100) : 0;
            return {nome:m.nome,rc:m.rc,dp:m.dp,ideal70:ideal70,ideal80:ideal80,saldo:m.saldo,ratio:ratio,m:m.m,temDados:m.temDados};
          });

          // Sobra acumulada
          var acumData = [];
          var acum = 0;
          chartData.forEach(function(m){
            if (m.temDados) { acum += m.saldo; }
            acumData.push({nome:m.nome,acum:Math.round(acum)});
          });

          return <div>
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:12}}><Calendar size={14} color={T.blue} /><h2 style={{margin:0,fontSize:15,fontWeight:700}}>Visão Anual {ano}</h2></div>

          {/* KPIs anuais */}
          <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6}}>
              <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"10px 8px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>RECEITA ANUAL</div>
                <div style={{fontSize:13,fontWeight:800,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{fK(totalRecAnual)}</div>
              </div>
              <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"10px 8px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>DESPESA ANUAL</div>
                <div style={{fontSize:13,fontWeight:800,color:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{fK(totalDespAnual)}</div>
              </div>
              <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"10px 8px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>SOBRA ANUAL</div>
                <div style={{fontSize:13,fontWeight:800,color:saldoAnual>=0?T.green:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{fK(saldoAnual)}</div>
              </div>
              <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"10px 8px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>COMPROMETIMENTO</div>
                <div style={{fontSize:13,fontWeight:800,color:pctComprAnual<=70?T.green:pctComprAnual<=80?T.gold:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{pctComprAnual}%</div>
              </div>
            </div>
          </div>

          {/* Gráfico receita vs despesa vs ideal */}
          <div style={Object.assign({},bx,{marginBottom:12})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:12,fontWeight:800}}>Receita vs Despesa vs Ideal</div>
              <div style={{display:"flex",gap:8,fontSize:11,color:T.dim}}>
                <span style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:6,height:6,borderRadius:3,background:T.green}} /> Receita</span>
                <span style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:6,height:6,borderRadius:3,background:T.red}} /> Despesa</span>
                <span style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:12,height:2,background:T.cyan}} /> Máx. ideal 70%</span>
                <span style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:12,height:2,borderTop:"2px dashed "+T.gold}} /> Limite máx. 80%</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={220}><ComposedChart data={chartData} barGap={2}><defs><linearGradient id="cRc" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.green} stopOpacity={1} /><stop offset="100%" stopColor={T.green} stopOpacity={0.4} /></linearGradient><linearGradient id="cDp" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.red} stopOpacity={0.9} /><stop offset="100%" stopColor={T.red} stopOpacity={0.35} /></linearGradient></defs><CartesianGrid strokeDasharray="2 6" stroke={T.cyan+"15"} vertical={false} /><XAxis dataKey="nome" tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"20"}} tickLine={false} /><YAxis tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"20"}} tickLine={false} tickFormatter={fK} /><Tooltip content={<CustomTooltip />} /><Bar dataKey="rc" name="Receita" fill="url(#cRc)" radius={[4,4,0,0]} style={{filter:"drop-shadow(0 0 4px "+T.green+"50)"}} /><Bar dataKey="dp" name="Despesa" fill="url(#cDp)" radius={[4,4,0,0]} style={{filter:"drop-shadow(0 0 4px "+T.red+"40)"}} /><Line type="monotone" dataKey="ideal70" name="Máx. ideal 70%" stroke={T.cyan} strokeWidth={2} dot={false} style={{filter:"drop-shadow(0 0 4px "+T.cyan+"80)"}} /><Line type="monotone" dataKey="ideal80" name="Limite máx. 80%" stroke={T.gold} strokeWidth={1.5} strokeDasharray="6 3" dot={false} style={{filter:"drop-shadow(0 0 4px "+T.gold+"60)"}} /></ComposedChart></ResponsiveContainer>
            <div style={{marginTop:10,padding:"12px 14px",borderRadius:10,background:"linear-gradient(135deg, rgba(0,229,255,0.08), rgba(0,255,136,0.04))",border:"1px solid rgba(0,229,255,0.15)"}}>
              <div style={{fontSize:12,fontWeight:900,color:T.cyan,marginBottom:6,letterSpacing:-0.2}}>↓ Quanto mais as barras vermelhas ficam ABAIXO das linhas, melhor sua saúde financeira.</div>
              <div style={{fontSize:11,color:T.dim}}>Linha ciano = máx. 70% (sobra 30% para investir) · Linha dourada = limite 80% (acima é crítico)</div>
            </div>
          </div>

          {/* Gráfico ratio despesa/receita por mês */}
          <div style={Object.assign({},bx,{marginBottom:12})}>
            <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Comprometimento mensal (despesa/receita)</div>
            <div style={{display:"flex",gap:3,alignItems:"flex-end",height:100,padding:"0 4px"}}>
              {chartData.map(function(m,i){
                var h = Math.min(100, m.ratio);
                var cor = m.ratio <= 70 ? T.green : m.ratio <= 80 ? T.gold : T.red;
                return <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                  <div style={{fontSize:10,fontWeight:700,color:cor}}>{m.temDados?m.ratio+"%":""}</div>
                  <div style={{width:"100%",height:h,borderRadius:"4px 4px 0 0",background:cor,opacity:m.temDados?0.7:0.15,transition:"height 0.3s"}} />
                  <div style={{fontSize:10,color:T.dim}}>{m.nome.slice(0,3)}</div>
                </div>;
              })}
            </div>
            <div style={{position:"relative",height:2,margin:"6px 0",background:"rgba(255,255,255,0.04)"}}>
              <div style={{position:"absolute",left:0,right:0,bottom:0,height:1,borderTop:"1px dashed "+T.cyan,opacity:0.4}} />
              <div style={{position:"absolute",right:0,top:-8,fontSize:10,color:T.cyan}}>70%</div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:T.dim,marginTop:4}}>
              <span>Média: <strong style={{color:totalRecAnual>0?(pctComprAnual<=70?T.green:pctComprAnual<=80?T.gold:T.red):T.dim,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{pctComprAnual}%</strong></span>
              <span>Máx. ideal: <strong style={{color:T.cyan}}>≤ 70%</strong> | Limite máx.: <strong style={{color:T.gold}}>≤ 80%</strong></span>
            </div>
          </div>

          {/* Sobra acumulada */}
          <div style={Object.assign({},bx,{marginBottom:12})}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
              <div style={{fontSize:12,fontWeight:800}}>Sobra acumulada {ano}</div>
              <div style={{fontSize:12,fontWeight:800,color:acum>=0?T.green:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(acum)}</div>
            </div>
            <ResponsiveContainer width="100%" height={120}><AreaChart data={acumData}><CartesianGrid strokeDasharray="2 6" stroke={T.cyan+"15"} vertical={false} /><XAxis dataKey="nome" tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"15"}} tickLine={false} /><YAxis tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"15"}} tickLine={false} tickFormatter={fK} /><Tooltip content={<CustomTooltip />} /><Area type="monotone" dataKey="acum" name="Acumulado" stroke={T.green} fill={T.green+"20"} strokeWidth={2} style={{filter:"drop-shadow(0 0 6px "+T.green+"60)"}} /></AreaChart></ResponsiveContainer>
          </div>

          {/* Média mensal */}
          <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
            <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Médias mensais ({mesesComDados} meses com dados)</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              <div style={{textAlign:"center"}}><div style={{fontSize:11,color:T.dim}}>RECEITA MÉDIA</div><div style={{fontSize:14,fontWeight:800,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(recMedia)}</div></div>
              <div style={{textAlign:"center"}}><div style={{fontSize:11,color:T.dim}}>DESPESA MÉDIA</div><div style={{fontSize:14,fontWeight:800,color:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(despMedia)}</div></div>
              <div style={{textAlign:"center"}}><div style={{fontSize:11,color:T.dim}}>SOBRA MÉDIA</div><div style={{fontSize:14,fontWeight:800,color:sobraMedia>=0?T.green:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(sobraMedia)}</div></div>
            </div>
          </div>

          {/* Cards por mês */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8}}>
            {visAnual.map(function(m,i){var ratio=m.rc>0?Math.round(m.dp/m.rc*100):0;var corR=ratio<=70?T.green:ratio<=80?T.gold:T.red;return <div key={i} onClick={function(){setMes(m.m);setTab("visao")}} style={Object.assign({},bx,{padding:12,cursor:"pointer",background:m.m===mes?"linear-gradient(135deg,"+T.card+","+T.green+"08)":T.card,borderColor:m.m===mes?T.green+"40":T.border})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <span style={{fontSize:12,fontWeight:700,color:m.m===mes?T.green:T.text}}>{MSF[m.m-1]}</span>
                {m.temDados && <span style={{fontSize:10,fontWeight:700,color:corR,background:corR+"12",padding:"1px 4px",borderRadius:4}}>{ratio}%</span>}
              </div>
              {!m.temDados && <Bd color={T.gold}>projeção</Bd>}
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginTop:4}}><span style={{color:T.dim}}>Rec.</span><span style={{color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:600}}>{fK(m.rc)}</span></div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginTop:2}}><span style={{color:T.dim}}>Desp.</span><span style={{color:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:600}}>{fK(m.dp)}</span></div>
              <div style={{marginTop:4,paddingTop:4,borderTop:"1px solid "+T.border,display:"flex",justifyContent:"space-between",fontSize:12}}><span style={{color:T.dim}}>Saldo</span><span style={{color:m.saldo>=0?T.green:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700}}>{fK(m.saldo)}</span></div>
            </div>})}
          </div>
        </div>;
        })()}

        {tab==="cal" && <div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
            <div style={{padding:5,borderRadius:8,background:T.blue+"12",display:"flex",border:"1px solid "+T.blue+"10"}}><Calendar size={15} color={T.blue} /></div>
            <h2 style={{margin:0,fontSize:17,fontWeight:900,letterSpacing:-0.3}}>Calendario: {MSF[mes-1]} {ano}</h2>
          </div>
          <div style={bx}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,marginBottom:4}}>
              {["Dom","Seg","Ter","Qua","Qui","Sex","Sab"].map(function(d){return <div key={d} style={{textAlign:"center",fontSize:11,fontWeight:700,color:T.dim,padding:"4px 0",textTransform:"uppercase"}}>{d}</div>})}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2}}>
              {(function(){
                var firstDay = new Date(ano, mes-1, 1).getDay();
                var cells = [];
                for (let e = 0; e < firstDay; e++) cells.push(<div key={"e"+e} />);
                calData.forEach(function(day){
                  var hj2 = new Date();
                  var isToday = day.d === hj2.getDate() && mes === hj2.getMonth()+1 && ano === hj2.getFullYear();
                  var isSelected = calDay === day.d;
                  cells.push(<div key={day.d} onClick={function(){setCalDay(calDay===day.d?0:day.d)}} style={{padding:"6px 2px",borderRadius:8,textAlign:"center",cursor:"pointer",background:isSelected?T.cyan+"15":(isToday?"rgba(255,255,255,0.06)":"transparent"),border:"1px solid "+(isSelected?T.cyan+"30":(isToday?T.cyan+"20":"transparent")),minHeight:48}}>
                    <div style={{fontSize:12,fontWeight:isToday?900:600,color:isToday?T.cyan:T.text}}>{day.d}</div>
                    <div style={{display:"flex",justifyContent:"center",gap:2,marginTop:3,flexWrap:"wrap"}}>
                      {day.rec > 0 && <div style={{width:5,height:5,borderRadius:3,background:T.green}} />}
                      {day.desp > 0 && <div style={{width:5,height:5,borderRadius:3,background:T.red}} />}
                      {day.hasFixa && <div style={{width:5,height:5,borderRadius:3,background:T.gold}} />}
                      {day.hasFat && <div style={{width:5,height:5,borderRadius:3,background:T.blue}} />}
                    </div>
                    {day.total > 0 && <div style={{fontSize:10,color:T.dim,marginTop:1}}>{day.total}</div>}
                  </div>);
                });
                return cells;
              })()}
            </div>
            <div style={{display:"flex",gap:12,marginTop:10,justifyContent:"center",fontSize:11,color:T.dim}}>
              <span style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:6,height:6,borderRadius:3,background:T.green}} /> Receita</span>
              <span style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:6,height:6,borderRadius:3,background:T.red}} /> Despesa</span>
              <span style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:6,height:6,borderRadius:3,background:T.gold}} /> Fixa</span>
              <span style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:6,height:6,borderRadius:3,background:T.blue}} /> Fatura</span>
            </div>
          </div>
          {calDay > 0 && (function(){
            var dayData = calData.find(function(d){return d.d===calDay});
            if (!dayData || dayData.lancs.length === 0) return <div style={Object.assign({},bx,{marginTop:12,textAlign:"center",padding:20})}><div style={{fontSize:12,color:T.dim}}>Nenhum lançamento no dia {calDay}</div></div>;
            var fixasDia = (db.fixas||[]).filter(function(f){return (f.dia||15)===calDay});
            return <div style={Object.assign({},bx,{marginTop:12})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Dia {calDay} de {MSF[mes-1]}</div>
              {fixasDia.length > 0 && <div style={{marginBottom:8}}><div style={{fontSize:11,color:T.gold,fontWeight:700,textTransform:"uppercase",marginBottom:4}}>Despesas fixas</div>{fixasDia.map(function(f){return <div key={f.id} style={{display:"flex",justifyContent:"space-between",padding:"5px 8px",borderRadius:6,background:T.gold+"06",marginBottom:3,fontSize:12}}><span style={{color:T.muted}}>{f.nome}</span><span style={{fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700,color:T.gold}}>{f$(f.valor)}</span></div>})}</div>}
              <div style={{display:"flex",flexDirection:"column",gap:4}}>{dayData.lancs.map(function(l){var isR=l.tipo==="receita";return <div key={l.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",borderRadius:8,background:T.cardAlt,border:"1px solid "+T.border}}><div><div style={{fontSize:12,fontWeight:600}}>{l.desc}</div><div style={{fontSize:11,color:T.dim}}>{l.tipo} {l.status} {l.pT>0&&l.pA+"/"+l.pT}</div></div><div style={{fontSize:12,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",color:isR?T.green:T.red}}>{isR?"+":"-"}{f$(l.valor)}</div></div>})}</div>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:8,paddingTop:6,borderTop:"1px solid "+T.border,fontSize:12}}><span style={{color:T.dim}}>Receitas: <span style={{color:T.green,fontWeight:700}}>{f$(dayData.rec)}</span></span><span style={{color:T.dim}}>Despesas: <span style={{color:T.red,fontWeight:700}}>{f$(dayData.desp)}</span></span></div>
            </div>;
          })()}
        </div>}

        {tab==="lanc" && <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
            <h2 style={{margin:0,fontSize:15,fontWeight:700}}>Lançamentos: {MSF[mes-1]} {ano}</h2>
            <div style={{display:"flex",gap:6}}>
              <button onClick={function(){setBulkMode(!bulkMode);setBulkSel({})}} style={{display:"flex",alignItems:"center",gap:4,padding:"7px 12px",borderRadius:8,background:bulkMode?T.cyan+"18":T.card,border:"1px solid "+(bulkMode?T.cyan+"35":T.border),color:bulkMode?T.cyan:T.muted,cursor:"pointer",fontSize:12,fontWeight:600}}><CheckCircle size={13} /> {bulkMode?"Cancelar":"Selecionar"}</button>
              <button onClick={function(){setModal({type:"lanc",title:"Novo",data:{}})}} style={{display:"flex",alignItems:"center",gap:4,padding:"7px 12px",borderRadius:8,background:"linear-gradient(135deg, "+T.green+", "+T.emerald+")",border:"none",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,boxShadow:"0 4px 12px rgba(16,185,129,0.20)"}}><Plus size={13} /> Novo</button>
            </div>
          </div>
          {bulkMode && <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap",padding:"10px 14px",borderRadius:14,background:T.cyan+"08",border:"1px solid "+T.cyan+"15"}}>
            <span style={{fontSize:12,color:T.cyan,fontWeight:700,alignSelf:"center"}}>{Object.keys(bulkSel).length} selecionado(s)</span>
            <div style={{flex:1}} />
            <button onClick={bulkSelectAll} style={{padding:"6px 12px",borderRadius:8,background:T.card,border:"1px solid "+T.border,color:T.muted,cursor:"pointer",fontSize:12,fontWeight:600}}>Selecionar pendentes</button>
            <button onClick={bulkMarkPago} style={{padding:"6px 12px",borderRadius:8,background:T.green,border:"none",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,boxShadow:"0 2px 8px rgba(16,185,129,0.20)"}}><span style={{display:"flex",alignItems:"center",gap:4}}><Check size={11} /> Marcar pagos</span></button>
          </div>}
          <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
            <div style={{flex:1,minWidth:130,position:"relative"}}><Search size={13} color={T.dim} style={{position:"absolute",left:9,top:8}} /><input value={busca} onChange={function(e){setBusca(e.target.value)}} placeholder="Buscar..." style={Object.assign({},inp,{paddingLeft:28,fontSize:12})} /></div>
            <select value={fTipo} onChange={function(e){setFTipo(e.target.value)}} style={Object.assign({},inp,{width:"auto",fontSize:12,padding:"5px 8px"})}><option value="">Tipo</option><option value="receita">Receita</option><option value="despesa">Despesa</option><option value="parcela">Parcela</option></select>
            <select value={fStat} onChange={function(e){setFStat(e.target.value)}} style={Object.assign({},inp,{width:"auto",fontSize:12,padding:"5px 8px"})}><option value="">Status</option><option value="pago">Pago</option><option value="pendente">Pendente</option></select>
            <select value={fPg} onChange={function(e){setFPg(e.target.value)}} style={Object.assign({},inp,{width:"auto",fontSize:12,padding:"5px 8px"})}><option value="">Pagamento</option><option value="pix">PIX</option><option value="cartao">Cartao</option></select>
            <select value={fCard} onChange={function(e){setFCard(e.target.value)}} style={Object.assign({},inp,{width:"auto",fontSize:12,padding:"5px 8px"})}><option value="">Cartao</option>{(db.cartoes||[]).map(function(c){return <option key={c.id} value={c.id}>{c.nome}</option>})}</select>
            <select value={fTitular} onChange={function(e){setFTitular(e.target.value)}} style={Object.assign({},inp,{width:"auto",fontSize:12,padding:"5px 8px"})}><option value="">Titular</option><option value="joao">Joao</option><option value="barbara">Barbara</option></select>
          </div>
          <div style={bx}>
            {lF.length===0 ? <EmptyState icon="list" title="Nenhum lançamento" subtitle={"em " + MSF[mes-1] + "/" + ano} color={T.cyan} /> :
            <div style={{display:"flex",flexDirection:"column",gap:5}}>
              {lF.map(function(l) {
                var isR = l.tipo==="receita";
                var cr = isR ? T.green : T.red;
                var isVirtual = !!l.virtual;
                var isBulkSelected = !!bulkSel[l.id];
                return <div key={l.id} style={{position:"relative",overflow:"hidden",borderRadius:9,marginBottom:1}}>
                  {swipeId===l.id && !isVirtual && <div style={{position:"absolute",right:0,top:0,bottom:0,display:"flex",alignItems:"center",gap:4,padding:"0 8px",zIndex:2,background:"linear-gradient(90deg, transparent, "+T.card+" 20%)"}}>
                    <button onClick={function(){togglePago(l)}} style={{padding:"6px 10px",borderRadius:8,background:l.status==="pago"?T.gold+"18":T.green+"18",border:"1px solid "+(l.status==="pago"?T.gold:T.green)+"25",color:l.status==="pago"?T.gold:T.green,cursor:"pointer",fontSize:11,fontWeight:700}}>{l.status==="pago"?"Pendente":"Pago"}</button>
                    <button onClick={function(){del("lancamentos",l.id);setSwipeId("")}} style={{padding:"6px 10px",borderRadius:8,background:T.red+"18",border:"1px solid "+T.red+"25",color:T.red,cursor:"pointer",fontSize:11,fontWeight:700}}>Excluir</button>
                    <button onClick={function(){setSwipeId("")}} style={{padding:"6px 8px",borderRadius:8,background:T.card,border:"1px solid "+T.border,color:T.dim,cursor:"pointer",fontSize:11}}><X size={11} /></button>
                  </div>}
                  <div className="row-hover" onClick={function(){if(!bulkMode&&!isVirtual){setSwipeId(swipeId===l.id?"":l.id)}}} style={{display:"flex",alignItems:"center",gap:8,padding:"9px 10px 9px 0",background:isBulkSelected?T.cyan+"10":(swipeId===l.id?T.cyan+"06":(isVirtual?T.card:T.cardAlt)),border:"1px solid "+(isBulkSelected?T.cyan+"30":(isVirtual?T.border+"80":T.border)),opacity:isVirtual?0.7:1,cursor:isVirtual?"default":"pointer",borderRadius:9,overflow:"hidden"}}>
                  <div style={{width:3,alignSelf:"stretch",background:catInfo(l.cat).cor||T.dim,borderRadius:"3px 0 0 3px",flexShrink:0}} />
                  {bulkMode && !isVirtual && <button onClick={function(){bulkToggle(l.id)}} style={{background:isBulkSelected?T.cyan+"25":"transparent",border:"2px solid "+(isBulkSelected?T.cyan:T.dim+"60"),borderRadius:5,width:20,height:20,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{isBulkSelected&&<Check size={12} color={T.cyan} />}</button>}
                  {!bulkMode && !isVirtual && <button onClick={function(){togPago(l.id)}} style={{background:l.status==="pago"?T.green+"20":"transparent",border:"1px solid "+(l.status==="pago"?T.green:T.dim),borderRadius:5,width:20,height:20,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{l.status==="pago"&&<Check size={12} color={T.green} />}</button>}
                  {isVirtual && <div style={{width:20,height:20,borderRadius:5,background:T.orange+"20",border:"1px solid "+T.orange+"40",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Activity size={10} color={T.orange} /></div>}
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.desc}</div>
                    <div style={{fontSize:11,color:T.dim,display:"flex",gap:6,flexWrap:"wrap",marginTop:1}}>
                      <span>{fD(l.data)}</span><span style={{display:"inline-flex",alignItems:"center",gap:2}}><span style={{fontSize:12}}>{catInfo(l.cat).emoji}</span>{catN(l.cat)}</span>
                      {l.pT>0&&<span>{l.pA}/{l.pT}</span>}
                      {l.totalCompra>0&&l.pT>1&&<span>Total {f$(l.totalCompra)}</span>}
                      {l.rec&&<Bd color={T.cyan}>rec</Bd>}
                      {l.tipo!=="receita"&& (getMetodoPg(l)==="cartao" ? <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"3px 8px",borderRadius:999,background:"rgba(59,130,246,0.12)",border:"1px solid rgba(59,130,246,0.22)"}}><BankMark card={(db.cartoes||[]).find(function(c){return c.id===l.cartaoId})||{}} size={18} /><span style={{fontSize:11,fontWeight:800,color:T.blue}}>{(((db.cartoes||[]).find(function(c){return c.id===l.cartaoId})||{}).nome || "cartao")}</span></span> : <Bd color={T.orange}>pix</Bd>)}
                      {isVirtual&&<Bd color={T.orange}>projetado</Bd>}
                    </div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:13,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",color:cr}}>{isR?"+":"-"}{f$(l.valor)}</div>
                    <Bd color={l.status==="pago"?T.green:T.gold}>{l.status}</Bd>
                  </div>
                  {!isVirtual && !bulkMode && <IBtn icon={Copy} onClick={function(){duplicateLanc(l)}} />}
                  {!isVirtual && !bulkMode && <IBtn icon={Edit3} onClick={function(){setModal({type:"lanc",title:"Editar",data:l})}} />}
                  {!isVirtual && !bulkMode && <IBtn icon={Trash2} color={T.red} onClick={function(){del("lancamentos",l.id)}} />}
                </div></div>;
              })}
            </div>}
            <div style={{marginTop:10,paddingTop:8,borderTop:"1px solid "+T.border,fontSize:12}}>
              {(function() {
                var reais = lF.filter(function(x){return !x.virtual});
                var totalVal = reais.reduce(function(a,l){return a+(l.tipo!=="receita"?l.valor:0)},0);
                var pagoVal = reais.filter(function(x){return x.status==="pago"&&x.tipo!=="receita"}).reduce(function(a,l){return a+l.valor},0);
                var pendVal = totalVal - pagoVal;
                return <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6}}>
                  <span style={{color:T.dim}}>{reais.length} reais + {lF.length-reais.length} projetados</span>
                  <div style={{display:"flex",gap:10,alignItems:"center"}}>
                    <span style={{color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700,fontSize:12}}>Pago {f$(pagoVal)}</span>
                    <span style={{color:T.gold,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700,fontSize:12}}>Pend. {f$(pendVal)}</span>
                    <span style={{color:T.muted,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:600,fontSize:12}}>Total {f$(totalVal)}</span>
                  </div>
                </div>;
              })()}
            </div>
          </div>
        </div>}

        {}
        {tab==="cards" && <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}><div style={{padding:5,borderRadius:8,background:T.blue+"12",display:"flex",border:"1px solid "+T.blue+"10"}}><CreditCard size={15} color={T.blue} /></div><h2 style={{margin:0,fontSize:17,fontWeight:900,letterSpacing:-0.3}}>Cartoes e Faturas: {MSF[mes-1]} {ano}</h2><Bd color={T.cyan}>premium</Bd></div>
            <button onClick={function(){setModal({type:"card",title:"Novo Cartão",data:{cor:T.blue,cor2:"#172554",band:"Cartao",fecha:3,venc:27,bankKey:"custom",emoji:"💳",logoUrl:"",visual:"black",statusEstr:"manter_estável",titular:"joao"}})}} style={{display:"flex",alignItems:"center",gap:5,padding:"8px 14px",borderRadius:12,background:"linear-gradient(135deg, "+T.green+", "+T.emerald+")",border:"none",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,boxShadow:"0 6px 20px rgba(16,185,129,0.25), inset 0 1px 0 rgba(255,255,255,0.15)"}}><Plus size={13} /> Cartão</button>
          </div>

          <div style={Object.assign({},bx,{marginBottom:14,background:"linear-gradient(135deg, rgba(10,18,32,0.97), rgba(59,130,246,0.05))",borderColor:T.blue+"18",position:"relative",overflow:"hidden"})}>
            <div style={{position:"absolute",inset:0,pointerEvents:"none",background:"radial-gradient(ellipse at 100% 50%, rgba(59,130,246,0.06), transparent 50%)"}} />
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(125px,1fr))",gap:8,position:"relative",zIndex:1}}>
              {[{l:"Fatura atual",v:totalFaturaAtual,c:T.blue},{l:"Proxima",v:totalProxFatura,c:T.cyan},{l:"2a proxima",v:totalSegundaFatura,c:T.purple},{l:"Limite total",v:totalLimites,c:T.greenL},{l:"Comprometido",v:totalComprometidoCartoes,c:T.orange},{l:"Livre real",v:totalLivreReal,c:T.green},{l:"Uso atual",v:usoTotalCartoes,c:T.gold,p:true},{l:"Uso real",v:usoRealCartoes,c:usoRealCartoes<=30?T.green:usoRealCartoes<=50?T.gold:T.red,p:true},{l:"Até salário",v:proxSal.faturas,c:T.red}].map(function(x,i){return <div key={i} style={{padding:"10px 12px",borderRadius:12,background:"rgba(255,255,255,0.03)",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",marginBottom:4,letterSpacing:0.3,fontWeight:700}}>{x.l}</div><div style={{fontSize:14,fontWeight:900,fontFamily:"'Inter', monospace",color:x.c}}>{x.p ? pct(x.v) : f$(x.v)}</div></div>;})}
            </div>
          </div>

          <div style={Object.assign({},bx,{marginBottom:12,padding:12})}>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <select value={fBankCards} onChange={function(e){setFBankCards(e.target.value)}} style={Object.assign({},inp,{width:"auto",fontSize:12,padding:"6px 9px"})}><option value="">Banco</option>{BANK_OPTIONS.map(function(o){return <option key={o.v} value={o.v}>{o.l}</option>})}</select>
              <select value={fFatStatus} onChange={function(e){setFFatStatus(e.target.value)}} style={Object.assign({},inp,{width:"auto",fontSize:12,padding:"6px 9px"})}><option value="">Status da fatura</option><option value="aberta">Em aberto</option><option value="paga">Paga</option><option value="divergencia">Com divergencia</option></select>
              <select value={fDivCards} onChange={function(e){setFDivCards(e.target.value)}} style={Object.assign({},inp,{width:"auto",fontSize:12,padding:"6px 9px"})}><option value="">Conciliação</option><option value="com">Com divergencia</option><option value="sem">Sem divergencia</option></select>
              {(fBankCards || fFatStatus || fDivCards) && <button onClick={function(){setFBankCards("");setFFatStatus("");setFDivCards("")}} style={{padding:"6px 10px",borderRadius:10,background:T.card,border:"1px solid "+T.border,color:T.muted,cursor:"pointer",fontSize:12,fontWeight:700}}>Limpar filtros</button>}
            </div>
          </div>

          {(function(){
            var meusCards = cardsView.filter(function(c){return (c.titular||"joao")==="joao"});
            var barbCards = cardsView.filter(function(c){return c.titular==="barbara"});
            var renderCard = function(c) {
              var brand = getBankPreset(c); var cardFx = getCardBrandStyle(c); var statusTone = getCardStatusColor(c.statusEstr); return <div key={c.id} className="holo-card" style={{background:"linear-gradient(160deg, rgba(15,25,41,0.98), rgba(6,12,22,0.95))",borderRadius:24,padding:20,border:"1px solid "+(c.statusEstr==="foco_mes"||c.statusEstr==="prioritario"?statusTone+"55":(c.cor||brand.bg)+"25"),boxShadow:"0 24px 60px rgba(0,4,12,0.40), 0 0 0 0.5px "+(c.cor||brand.bg)+"15, 0 0 40px "+(c.cor||brand.bg)+"10, "+(c.statusEstr==="foco_mes"?"0 0 50px "+statusTone+"20":"0 0 0 transparent"),position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",inset:0,pointerEvents:"none",background:"radial-gradient(circle at 0% 0%, "+(c.cor||brand.bg)+"28, transparent 36%), radial-gradient(circle at 100% 100%, "+brand.ring+"20, transparent 26%)"}} />
                <div style={{position:"absolute",top:0,left:20,right:20,height:1,background:"linear-gradient(90deg, transparent, "+(c.cor||brand.bg)+"80, transparent)",pointerEvents:"none"}} />
                <span style={{position:"absolute",top:0,left:0,width:12,height:12,borderTop:"1px solid "+(c.cor||brand.bg)+"60",borderLeft:"1px solid "+(c.cor||brand.bg)+"60",pointerEvents:"none"}} />
                <span style={{position:"absolute",top:0,right:0,width:12,height:12,borderTop:"1px solid "+(c.cor||brand.bg)+"60",borderRight:"1px solid "+(c.cor||brand.bg)+"60",pointerEvents:"none"}} />
                <span style={{position:"absolute",bottom:0,left:0,width:12,height:12,borderBottom:"1px solid "+(c.cor||brand.bg)+"60",borderLeft:"1px solid "+(c.cor||brand.bg)+"60",pointerEvents:"none"}} />
                <span style={{position:"absolute",bottom:0,right:0,width:12,height:12,borderBottom:"1px solid "+(c.cor||brand.bg)+"60",borderRight:"1px solid "+(c.cor||brand.bg)+"60",pointerEvents:"none"}} />
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:12,position:"relative",zIndex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}><BankMark card={c} size={46} /><div><div style={{fontSize:16,fontWeight:900,letterSpacing:0.2}}>{c.nome}</div><div style={{fontSize:12,color:T.muted,marginTop:3,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}><NetChip label={c.band || "Cartao"} /><BankBadge color={brand.bg}>{brand.label}</BankBadge><BankBadge color={getCardStatusColor(c.statusEstr)}>{getCardStatusLabel(c.statusEstr)}</BankBadge><span>{"fecha "+c.fecha+" vence "+c.venc}</span></div></div></div>
                  <div style={{display:"flex",gap:6,position:"relative",zIndex:1}}>
                    <IBtn icon={Edit3} onClick={function(){setModal({type:"card",title:"Editar Cartao",data:(db.cartoes||[]).find(function(x){return x.id===c.id})})}} />
                    <IBtn icon={Trash2} color={T.red} onClick={function(){delCartaoSeguro(c.id)}} />
                  </div>
                </div>
                <div style={{marginBottom:12}}><CardFace card={c} /></div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginBottom:12}}>
                  <div style={mc}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",letterSpacing:1,fontWeight:700}}>◇ Limite</div><div className="mono-num" style={{fontSize:14,fontWeight:800,marginTop:3,color:T.text}}>{f$(c.limite)}</div></div>
                  <div style={mc}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",letterSpacing:1,fontWeight:700}}>◇ Livre do mes</div><div className="mono-num" style={{fontSize:14,fontWeight:800,color:T.green,marginTop:3,textShadow:"0 0 8px "+T.green+"40"}}>{f$(c.livre)}</div></div>
                  <div style={mc}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",letterSpacing:1,fontWeight:700}}>◇ Comprometido</div><div className="mono-num" style={{fontSize:14,fontWeight:800,color:T.orange,marginTop:3,textShadow:"0 0 8px "+T.orange+"40"}}>{f$(c.comprometido)}</div></div>
                  <div style={mc}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",letterSpacing:1,fontWeight:700}}>◇ Livre real</div><div className="mono-num" style={{fontSize:14,fontWeight:800,color:T.greenL,marginTop:3,textShadow:"0 0 8px "+T.greenL+"40"}}>{f$(c.livreReal)}</div></div>
                  <div style={mc}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",letterSpacing:1,fontWeight:700}}>◇ Uso do limite</div><div className="mono-num" style={{fontSize:14,fontWeight:800,color:c.usoPct<=30?T.green:c.usoPct<=50?T.gold:T.red,marginTop:3,textShadow:"0 0 8px "+(c.usoPct<=30?T.green:c.usoPct<=50?T.gold:T.red)+"40"}}>{pct(c.usoPct)}</div></div>
                  <div style={mc}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",letterSpacing:1,fontWeight:700}}>◇ Uso real</div><div className="mono-num" style={{fontSize:14,fontWeight:800,color:c.usoRealPct<=30?T.green:c.usoRealPct<=50?T.gold:T.red,marginTop:3,textShadow:"0 0 8px "+(c.usoRealPct<=30?T.green:c.usoRealPct<=50?T.gold:T.red)+"40"}}>{pct(c.usoRealPct)}</div></div>
                </div>
                {c.faturas.some(function(f){ return !f.conciliado; }) && <div style={{marginBottom:10,padding:"9px 12px",borderRadius:12,background:T.red+"08",border:"1px solid "+T.red+"18",fontSize:12,color:T.muted,position:"relative",zIndex:1}}><strong style={{color:T.red}}>Divergência:</strong> existe diferença entre valor manual e lancamentos em ao menos uma fatura.</div>}{c.obs && <div style={{marginBottom:12,padding:"10px 12px",borderRadius:12,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",fontSize:12,color:T.muted,position:"relative",zIndex:1}}><strong style={{color:T.text}}>Obs.:</strong> {c.obs}</div>}
                <div style={{display:"grid",gap:8}}>
                  {c.faturas.map(function(f) {
                    return <div key={f.key} style={{padding:"13px 14px",borderRadius:16,background:"rgba(255,255,255,0.03)",border:"1px solid "+(f.paga?"rgba(16,185,129,0.20)":"rgba(255,255,255,0.05)"),boxShadow:"inset 0 1px 0 rgba(255,255,255,0.025), 0 4px 12px rgba(0,0,0,0.08)"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginBottom:6}}>
                        <div>
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}><div style={{fontSize:12,fontWeight:700}}>{f.titulo}</div>{f.manual && <Bd color={T.cyan}>manual</Bd>}{f.paga && <Bd color={T.green}>paga</Bd>}</div>
                          <div style={{fontSize:11,color:T.dim,marginTop:4}}>Referencia {MSF[f.mes-1]}/{f.ano}</div>
                        </div>
                        <div style={{minWidth:120,textAlign:"right"}}>
                          <EV value={f.total} onChange={function(v){updFatManual(c.id, f.mes, f.ano, {valorManual:v})}} />
                          <div style={{fontSize:11,color:T.dim,marginTop:3}}>Auto: {f$(f.totalAuto)}</div>
                        </div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr auto auto auto",gap:6,alignItems:"center",marginBottom:8}}>
                        <div style={{fontSize:12,color:T.muted}}>Vencimento: <strong style={{color:T.text}}>{fD(isoDt(f.vencDate))}</strong></div>
                        <div style={{display:"flex",alignItems:"center",gap:4,fontSize:12,color:T.dim}}>dia<EV value={f.vencDia} onChange={function(v){updFatManual(c.id, f.mes, f.ano, {vencDia: Math.max(1, Math.min(31, parseInt(v)||1))})}} /></div>
                        <button onClick={function(){askMarcarFatura(c.id, f.mes, f.ano, f.total, f.vencDate, f.paga)}} style={{padding:"6px 8px",borderRadius:7,background:f.paga?T.green+"18":T.card,border:"1px solid "+(f.paga?T.green+"35":T.border),color:f.paga?T.green:T.muted,cursor:"pointer",fontSize:12,fontWeight:700}}>{f.paga?"Fatura paga":"Marcar paga"}</button>
                        <div style={{display:"flex",gap:4}}>
                          <button onClick={function(){askResetFatValor(c.id, f.mes, f.ano)}} style={{padding:"6px 8px",borderRadius:7,background:T.card,border:"1px solid "+T.border,color:T.muted,cursor:"pointer",fontSize:12}}>Reset valor</button>
                          <button onClick={function(){askResetFatVenc(c.id, f.mes, f.ano)}} style={{padding:"6px 8px",borderRadius:7,background:T.card,border:"1px solid "+T.border,color:T.muted,cursor:"pointer",fontSize:12}}>Reset venc.</button>
                        </div>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",gap:8,marginBottom:8,fontSize:12,flexWrap:"wrap"}}><span style={{color:f.conciliado?T.green:T.gold}}>Conferir fatura: {f.conciliado ? "ok" : (f.divergencia>0?"+":"") + f$(f.divergencia)}</span>{f.paga && f.pagoEm && <span style={{color:T.green}}>Pago em {fD(f.pagoEm)}</span>}</div>{f.itens.length===0 ? <div style={{fontSize:12,color:T.dim}}>Nenhum lançamento nesta fatura.</div> : <div style={{display:"flex",flexDirection:"column",gap:5}}>{f.itens.map(function(it){return <div key={it.id} style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:12}}><span style={{color:T.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.desc}</span><span style={{fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700}}>{f$(it.valor)}</span></div>;})}</div>}
                    </div>;
                  })}
                </div>
                {c.historicoPagas.length>0 && <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid "+T.border}}><div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Histórico de faturas pagas</div><div style={{display:"flex",flexDirection:"column",gap:5}}>{c.historicoPagas.slice(0,6).map(function(h){return <div key={h.key} style={{display:"grid",gridTemplateColumns:"1fr auto auto",gap:8,fontSize:12,padding:"7px 8px",borderRadius:8,background:T.cardAlt}}><span style={{color:T.muted}}>{h.ref}</span><span style={{fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontWeight:700}}>{f$(h.valor)}</span><span style={{color:T.dim}}>{h.pagoEm ? fD(h.pagoEm) : "--"}</span></div>;})}</div></div>}
              </div>;
            };
            if (cardsView.length === 0) return <div style={bx}><div style={{textAlign:"center",padding:28,color:T.dim}}><CreditCard size={22} color={T.blue} /><div style={{fontSize:12,fontWeight:700,marginTop:8}}>Nenhum cartão encontrado</div></div></div>;
            return <div>
              {meusCards.length > 0 && <div style={{marginBottom:20}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}><div style={{padding:4,borderRadius:8,background:T.cyan+"12",border:"1px solid "+T.cyan+"10",display:"flex"}}><CreditCard size={14} color={T.cyan} /></div><div style={{fontSize:14,fontWeight:900,color:T.cyan}}>Meus Cartoes</div><Bd color={T.cyan}>{meusCards.length}</Bd></div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>{meusCards.map(renderCard)}</div>
              </div>}
              {barbCards.length > 0 && <div>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}><div style={{padding:4,borderRadius:8,background:T.orange+"12",border:"1px solid "+T.orange+"10",display:"flex"}}><CreditCard size={14} color={T.orange} /></div><div style={{fontSize:14,fontWeight:900,color:T.orange}}>Cartoes da Barbara</div><Bd color={T.orange}>{barbCards.length}</Bd></div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>{barbCards.map(renderCard)}</div>
              </div>}
            </div>;
          })()}
        </div>}

        {}
        {tab==="rating" && (function(){
          var CALENDAR_ITEMS = [
            {day:"25",title:"DIA DO SALÁRIO",color:T.green,items:["Salário entrou no Santander","Travar almofada R$ 8.000 (não mexer)","Conferir DDA + débitos automáticos"]},
            {day:"26",title:"DIA DO RATING",color:T.purple,items:["Investir R$ 5.000 no Santander","→ R$ 2.000 em CDB Liquidez Diária","→ R$ 3.000 em LCI/LCA (prazo)"]},
            {day:"29",title:"DIA DO PEDIDO",color:T.gold,items:["Almofada R$ 8.000 mantida","Investimento do mês aplicado","Renda cadastrada: R$ 30.000 no app","Open Finance ativo","SOLICITAR cartão Unlimited (1×/mês)"]}
          ];
          var DEBITS_LIST = ["Energia","Água","Internet","Celular","Pl. Saúde","Condomínio","Seguro","Previdência","Stream. 1","Stream. 2","Fixo 1","Fixo 2"];
          var BOOST_ITEMS = ["20+ transações/mês no Santander","Patrimônio crescente (nunca resgatar)","Liquidez diária além da almofada","Open Finance ativo 90+ dias","Anti-pico avançado (lotes semanais)","Pedido com holerite/IR via gerente Select","90 dias sem pedir crédito em outros bancos","Login diário App Way + App Santander","Gerente Select fixo (tratar pelo nome)","Previdência PGBL R$ 100+/mês contratada","Carteira digital ativa (Apple/Google Pay)","Serasa Premium assinado (R$ 23,90/mês)","1+ compra internacional/mês no AAdvantage","Gasto progressivo (+R$ 500/mês de escada)","Pagamento pré-fechamento (hack utilização)"];
          var PROIBIDO_ITEMS = ["Não atrasei nenhum pagamento","Não entrei no cheque especial","Não usei rotativo (100% sempre)","Não fiz renegociação de dívida","Não estourei limite","Não fiz spam de solicitações","Não pedi crédito em outros bancos","Não fiz simulações repetidas","Santander não virou conta-passagem","Sem pingue-pongue de investimento","Anti-pico aplicado","Sem parcelamentos novos","Cadastro atualizado (renda/endereço/tel)","Sem pendências/boletos esquecidos","Open Finance estável","Não fiz chargeback/contestação","Não fiz saque no crédito","Monitorei 3 birôs (Serasa+BoaVista+Quod)"];
          var PARCELAS_DATA = [
            {n:"Amazon",v:15.40,t:2},{n:"Dock Robô",v:57,t:2},{n:"Lacoste",v:190,t:2},
            {n:"Levis",v:150,t:3},{n:"Smiles",v:105,t:3},
            {n:"Leroy 2",v:117.24,t:4},{n:"Rei Cast.",v:62.83,t:4},{n:"Decolar",v:133.35,t:4},{n:"Aspirador",v:209.57,t:4},
            {n:"UNIP",v:371,t:5},
            {n:"iFood",v:541.81,t:6},{n:"Invicta",v:81.20,t:6},{n:"SeaWorld",v:119.42,t:6},
            {n:"Bicicleta",v:115,t:7},{n:"Boticário",v:22.15,t:7},{n:"Azzaro",v:45.66,t:7},{n:"Invictus",v:37,t:7},
            {n:"Viag.Fort.",v:50,t:8},{n:"Leroy",v:199.98,t:8},
            {n:"Serasa 1",v:96.36,t:9,s:1},{n:"Serasa 2",v:51.76,t:9,s:1},
            {n:"Emp.Barbara",v:614,t:9},{n:"Parc.Itaú",v:300,t:9},{n:"Pintura",v:76.54,t:9},
            {n:"Tampa",v:9.17,t:9},{n:"ML",v:11.83,t:9},{n:"Livelo",v:102.12,t:9},
            {n:"Estratégia",v:54.77,t:9},{n:"Spike",v:106.84,t:9},{n:"Kindle",v:161.21,t:9},
            {n:"Emp.Bradesco",v:568.60,t:9}
          ];
          var CARD_DATES = ["29/04","29/05","29/06","29/07","31/08","29/09","29/10","30/11","29/12"];
          var WEEKLY_TASKS = [{day:"Segunda",tasks:["1 Pix pequeno","1 pagamento (boleto/conta)"]},{day:"Quinta",tasks:["1 Pix pequeno","1 pagamento (boleto/conta)"]}];
          var MELHORIAS = [
            {t:"Renda no app Santander",d:"Cadastrar R$ 30.000 (inclua benefícios, extras). DIRPF justifica.",ic:"💰"},
            {t:"Open Finance",d:"Conectar Itaú e Bradesco ao Santander. Ele vê patrimônio total e limite R$ 18.500 no Itaú.",ic:"🔗"},
            {t:"Gerente Select fixo",d:"Ligar e pedir gerente dedicado. Na hora do upgrade, ele advoga por você.",ic:"🤝"},
            {t:"Previdência PGBL",d:"R$ 100/mês no Santander. Produto + deduz até 12% do IR.",ic:"📈"},
            {t:"Login diário",d:"Abrir App Way + App Santander todo dia. Engajamento digital é rastreado.",ic:"📱"},
            {t:"Cartão consignado",d:"Se disponível para servidor: aprovação quase garantida.",ic:"💳"}
          ];
          var debtGroups = {};
          PARCELAS_DATA.forEach(function(p){if(!debtGroups[p.t])debtGroups[p.t]=[];debtGroups[p.t].push(p);});
          var debtEntries = Object.keys(debtGroups).sort(function(a,b){return a-b}).map(function(t){
            var items=debtGroups[t]; var moIdx=parseInt(t)-1+3;
            var MN2=["JAN","FEV","MAR","ABR","MAI","JUN","JUL","AGO","SET","OUT","NOV","DEZ"];
            var moLabel=moIdx<12?MN2[moIdx]+"/26":MN2[moIdx-12]+"/27";
            return{t:parseInt(t),moLabel:moLabel,items:items,total:items.reduce(function(s,p){return s+p.v},0)};
          });
          var coachBx = Object.assign({},bx,{marginBottom:10,padding:16});
          var subTabs = [{id:"plano",lb:"Plano",ic:"🎯"},{id:"cartoes",lb:"Cartões",ic:"💳"},{id:"tracker",lb:"Tracker",ic:"📊"},{id:"dividas",lb:"Dívidas",ic:"📉"},{id:"regras",lb:"Regras",ic:"⚖️"}];

          return <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}><div style={{padding:5,borderRadius:8,background:ratingColor+"12",display:"flex",border:"1px solid "+ratingColor+"10"}}><Shield size={15} color={ratingColor} /></div><h2 style={{margin:0,fontSize:15,fontWeight:900,letterSpacing:-0.3}}>Coaching Financeiro</h2></div>
            <div style={{fontSize:12,fontWeight:900,color:ratingColor,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{ratingScore}/100</div>
          </div>

          {/* Sub-tabs */}
          <div style={{display:"flex",gap:3,marginBottom:12,overflowX:"auto",scrollbarWidth:"none"}}>
            {subTabs.map(function(st2){var act=coachSub===st2.id;return <button key={st2.id} onClick={function(){setCoachSub(st2.id)}} style={{flex:1,padding:"7px 4px",border:"none",borderRadius:10,cursor:"pointer",fontFamily:"inherit",background:act?"rgba(0,229,255,0.08)":"rgba(255,255,255,0.02)",border:act?"1px solid rgba(0,229,255,0.12)":"1px solid transparent",transition:"all 0.2s"}}><div style={{fontSize:13}}>{st2.ic}</div><div style={{fontSize:11,fontWeight:act?700:400,color:act?T.cyan:T.dim,marginTop:2}}>{st2.lb}</div></button>;})}
          </div>

          {/* 30-SECOND MONTHLY SUMMARY */}
          {(function(){
            var resumos = {
              1:{foco:"Planejamento anual",acao:"Defina metas. Organize documentos (IRPF). Revise cadastro Santander.",emoji:"📋",cor:T.cyan},
              2:{foco:"Consistência",acao:"Mantenha o plano. Pague tudo em dia. Consulte score nos 3 birôs.",emoji:"📊",cor:T.cyan},
              3:{foco:"Preparação",acao:"Abra conta Select. Porte salário. 1ª aplicação R$ 5k no Santander.",emoji:"🚀",cor:T.gold},
              4:{foco:"IGNIÇÃO",acao:"Select aberta. Salário portado. Invista R$ 5k dia 26. Peça AAdvantage aumento dia 5/5.",emoji:"🚀",cor:T.gold},
              5:{foco:"Construção",acao:"2º mês Select. Gaste R$ 3.000 no AAdvantage. Peça aumento dia 5. Tente Unlimited dia 29.",emoji:"🔧",cor:T.cyan},
              6:{foco:"Aceleração",acao:"Peça aumento Itaú dia 5. Tente Unlimited dia 29. R$ 15k+ investidos.",emoji:"⚡",cor:T.purple},
              7:{foco:"Consistência",acao:"Gaste R$ 3.500 no AAdvantage (escada). Mantenha anti-pico. Score subindo.",emoji:"📈",cor:T.cyan},
              8:{foco:"Preparação premium",acao:"Peça aumento AAdvantage dia 5. Tente Unlimited dia 29. R$ 30k+ investidos.",emoji:"📈",cor:T.purple},
              9:{foco:"6 meses Select!",acao:"Marco crítico! Tente Unlimited dia 29. Reforce argumento com gerente.",emoji:"🎯",cor:T.gold},
              10:{foco:"⭐ JANELA PREMIUM",acao:"Melhor mês! Peça aumento dia 5. UNLIMITED dia 29. Bancos liberam mais pré-Black Friday!",emoji:"⭐",cor:T.gold},
              11:{foco:"⭐ JANELA PREMIUM",acao:"2ª melhor janela! Tente Unlimited dia 30. Gaste forte no AAdvantage.",emoji:"⭐",cor:T.gold},
              12:{foco:"LIBERTAÇÃO",acao:"Dívidas quitam! Nome limpo! Tente Unlimited dia 29. Peça aumento Itaú dia 5.",emoji:"🎆",cor:T.green}
            };
            var r = resumos[mes] || {foco:"Execute o plano",acao:"Siga o checklist. Pague em dia. Invista dia 26.",emoji:"📋",cor:T.cyan};
            return <div style={Object.assign({},bx,{marginBottom:12,padding:0,overflow:"hidden",background:"linear-gradient(135deg, "+r.cor+"12, rgba(0,0,0,0.20))",borderColor:r.cor+"25"})}>
              <div style={{padding:"14px 16px",position:"relative"}}>
                <div style={{position:"absolute",top:-10,right:-10,fontSize:40,opacity:0.06}}>{r.emoji}</div>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,position:"relative"}}>
                  <span style={{fontSize:20}}>{r.emoji}</span>
                  <div>
                    <div style={{fontSize:11,color:T.dim,letterSpacing:2,fontWeight:700}}>FOCO DE {MSF[mes-1].toUpperCase()}</div>
                    <div style={{fontSize:15,fontWeight:900,color:r.cor,lineHeight:1.2}}>{r.foco}</div>
                  </div>
                </div>
                <div style={{fontSize:12,color:T.text,lineHeight:1.6,fontWeight:500,position:"relative"}}>{r.acao}</div>
              </div>
              <div style={{height:3,background:"linear-gradient(90deg, "+r.cor+", "+r.cor+"40, transparent)",borderRadius:"0 0 0 0"}} />
            </div>;
          })()}

          {/* ═══ PLANO ═══ */}
          {coachSub==="plano" && <div>
            {/* Metas fixas */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.cyan,marginBottom:10}}>🎛️ METAS FIXAS DO MÊS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                {[{l:"Almofada",v:"R$ 8k",c:T.cyan},{l:"Investir",v:"R$ 5k",c:T.purple},{l:"Débitos",v:"8-12",c:T.gold},{l:"Pagamentos",v:"10+",c:T.green},{l:"Transações",v:"20+",c:T.orange},{l:"Atrasos",v:"ZERO",c:T.red}].map(function(m,i){return <div key={i} style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"7px 9px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}><div style={{fontSize:11,color:T.dim,letterSpacing:0.4,fontWeight:600}}>{m.l.toUpperCase()}</div><div style={{fontSize:14,fontWeight:800,color:m.c,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",marginTop:2}}>{m.v}</div></div>;})}
              </div>
            </div>

            {/* Calendário */}
            {CALENDAR_ITEMS.map(function(cal,ci){return <div key={ci} style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:cal.color,marginBottom:8}}>📅 DIA {cal.day} — {cal.title}</div>
              {cal.items.map(function(item,ii){var k="coach_cal_"+ci+"_"+ii;var on=!!(ratingMes[k]);return <div key={ii} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:ii<cal.items.length-1?"1px solid rgba(255,255,255,0.03)":"none"}}><button onClick={function(){togRatingTask(k)}} style={{width:18,height:18,borderRadius:"50%",border:"1.5px solid "+(on?T.green:cal.color),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s"}}>{on&&<Check size={10} color="#020208" />}</button><span style={{fontSize:12,color:on?T.dim:T.muted,textDecoration:on?"line-through":"none",lineHeight:1.4}}>{item}</span></div>;})}
            </div>;})}

            {/* Transaction counter */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.orange,marginBottom:10}}>📊 CONTADOR DE TRANSAÇÕES</div>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:42,fontWeight:900,color:txCount>=20?T.green:T.orange,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",lineHeight:1}}>{txCount}</div>
                <div style={{fontSize:11,color:T.dim,marginTop:4}}>de 20 transações (Pix / boleto / débito)</div>
                <PB value={Math.min(txCount,20)} max={20} color={txCount>=20?T.green:T.orange} h={5} />
                <div style={{display:"flex",gap:6,justifyContent:"center",marginTop:10}}>
                  <button onClick={function(){setTxCount(txCount+1)}} style={{padding:"8px 22px",borderRadius:10,background:T.orange+"18",border:"1px solid "+T.orange+"30",color:T.orange,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Transação</button>
                  <button onClick={function(){setTxCount(0)}} style={{padding:"8px 14px",borderRadius:10,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",color:T.dim,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Zerar</button>
                </div>
              </div>
            </div>

            {/* Anti-Pico */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.orange,marginBottom:8}}>🌊 ANTI-PICO — SALDO MÉDIO ESTÁVEL</div>
              <div style={{background:"rgba(255,138,80,0.04)",borderRadius:10,padding:10,marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{textAlign:"center"}}><div style={{fontSize:10,color:T.dim}}>PISO</div><div style={{fontSize:13,fontWeight:800,color:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>R$ 8k</div></div>
                <div style={{flex:1,height:4,borderRadius:4,background:"rgba(255,255,255,0.04)",margin:"0 10px",position:"relative"}}><div style={{position:"absolute",left:"25%",right:"15%",height:"100%",borderRadius:4,background:"linear-gradient(90deg,"+T.green+"20,"+T.cyan+"20)"}}/></div>
                <div style={{textAlign:"center"}}><div style={{fontSize:10,color:T.dim}}>TETO</div><div style={{fontSize:13,fontWeight:800,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>R$ 14k</div></div>
              </div>
              <div style={{fontSize:11,color:T.dim,lineHeight:1.5}}>Lote 1 (dias 26-30): essenciais. Lote 2 (dias 03-07): contas grandes. Lote 3 (dias 10-14): restantes. Excesso acima de R$ 14k → CDB liquidez.</div>
            </div>

            {/* Débitos automáticos */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.purple,marginBottom:8}}>🔁 DÉBITOS AUTOMÁTICOS (8-12)</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3}}>
                {DEBITS_LIST.map(function(d,i){var k="coach_deb_"+i;var on=!!(ratingMes[k]);return <div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"4px 6px",borderRadius:7,background:on?"rgba(0,255,136,0.03)":"rgba(255,255,255,0.01)",border:"1px solid "+(on?"rgba(0,255,136,0.08)":"rgba(255,255,255,0.03)")}}><button onClick={function(){togRatingTask(k)}} style={{width:16,height:16,borderRadius:"50%",border:"1.5px solid "+(on?T.green:T.purple),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{on&&<Check size={8} color="#020208" />}</button><span style={{fontSize:11,color:on?T.dim:T.muted}}>{d}</span></div>;})}
              </div>
              <div style={{textAlign:"center",marginTop:6}}><span style={{fontSize:12,fontWeight:700,color:T.purple,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{DEBITS_LIST.filter(function(_,i){return !!(ratingMes["coach_deb_"+i])}).length}/12</span></div>
            </div>

            {/* Pagamentos */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.green,marginBottom:8}}>🧾 PAGAMENTOS NO MÊS (10+)</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                {Array.from({length:13},function(_,i){var k="coach_pay_"+i;var on=!!(ratingMes[k]);return <button key={i} onClick={function(){togRatingTask(k)}} style={{padding:"4px 9px",borderRadius:7,background:on?"rgba(0,255,136,0.06)":"rgba(255,255,255,0.01)",border:"1px solid "+(on?"rgba(0,255,136,0.1)":"rgba(255,255,255,0.04)"),color:on?T.green:T.dim,fontSize:11,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",cursor:"pointer"}}>{on?"✓ ":""}{i+1}</button>;})}
              </div>
            </div>

            {/* Boost */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.gold,marginBottom:8}}>🚀 BOOST MÁXIMO</div>
              {BOOST_ITEMS.map(function(item,i){var k="coach_boost_"+i;var on=!!(ratingMes[k]);return <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:i<BOOST_ITEMS.length-1?"1px solid rgba(255,255,255,0.02)":"none"}}><button onClick={function(){togRatingTask(k)}} style={{width:16,height:16,borderRadius:"50%",border:"1.5px solid "+(on?T.green:T.gold),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{on&&<Check size={8} color="#020208" />}</button><span style={{fontSize:11,color:on?T.dim:T.muted,textDecoration:on?"line-through":"none",lineHeight:1.4}}>{item}</span>{on&&<span style={{fontSize:10,fontWeight:700,color:T.green,background:T.green+"12",padding:"1px 5px",borderRadius:4,marginLeft:"auto"}}>OK</span>}</div>;})}
            </div>

            {/* Checklist final */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.green,marginBottom:8}}>✅ CHECKLIST FINAL DO MÊS</div>
              {["Salário dia 25 ok","Investimento dia 26 ok","Anti-pico aplicado","Boost Máximo marcado","Tentativa de cartão feita","Zero cheque especial e atrasos"].map(function(item,i){var k="coach_final_"+i;var on=!!(ratingMes[k]);return <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:i<5?"1px solid rgba(255,255,255,0.02)":"none"}}><button onClick={function(){togRatingTask(k)}} style={{width:18,height:18,borderRadius:"50%",border:"1.5px solid "+(on?T.green:T.cyan),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{on&&<Check size={10} color="#020208" />}</button><span style={{fontSize:12,fontWeight:on?400:600,color:on?T.green:T.text,textDecoration:on?"line-through":"none"}}>{item}</span></div>;})}
            </div>
          </div>}

          {/* ═══ CARTÕES ═══ */}
          {coachSub==="cartoes" && <div>
            {/* Calendário de datas */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.cyan,marginBottom:10}}>📅 CALENDÁRIO DE AÇÕES — CARTÕES 2026/2027</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:10}}>Datas fixas para pedir aumento de limite, upgrade e tentativas de cartão</div>
              {[
                {data:"05/05/2026",acao:"🔴 Santander: 1º aumento AAdvantage (2 dias pós-fechamento, fatura paga)",tipo:"aumento",cor:"#E11931"},
                {data:"29/05/2026",acao:"🔴 Santander: 2ª tentativa Unlimited (dia 29, pós-salário e aporte)",tipo:"upgrade",cor:"#E11931"},
                {data:"05/06/2026",acao:"🟠 Itaú: 1º aumento Platinum (pós-fechamento fatura)",tipo:"aumento",cor:"#FF7A00"},
                {data:"29/06/2026",acao:"🔴 Santander: 3ª tentativa Unlimited",tipo:"upgrade",cor:"#E11931"},
                {data:"05/08/2026",acao:"🔴 Santander: 2º aumento AAdvantage (90 dias do 1º, pós-fechamento)",tipo:"aumento",cor:"#E11931"},
                {data:"29/08/2026",acao:"🔴 Santander: 5ª tentativa Unlimited",tipo:"upgrade",cor:"#E11931"},
                {data:"29/09/2026",acao:"🔴 Santander: 6ª tentativa Unlimited (6 meses Select!)",tipo:"upgrade",cor:"#E11931"},
                {data:"05/10/2026",acao:"⭐ JANELA PREMIUM: pré-Black Friday. Bancos liberam mais limite!",tipo:"premium",cor:T.gold},
                {data:"05/10/2026",acao:"🔴 Santander: 3º aumento AAdvantage (janela premium!)",tipo:"aumento",cor:T.gold},
                {data:"29/10/2026",acao:"⭐ 🔴 Santander: 7ª tentativa Unlimited (ALVO PRINCIPAL + janela premium)",tipo:"upgrade",cor:T.gold},
                {data:"05/11/2026",acao:"⭐ JANELA PREMIUM: bancos competem por clientes. Melhor momento!",tipo:"premium",cor:T.gold},
                {data:"30/11/2026",acao:"🔴 Santander: 8ª tentativa Unlimited (janela premium novembro)",tipo:"upgrade",cor:T.gold},
                {data:"05/12/2026",acao:"🟠 Itaú: 2º aumento Platinum (6 meses, pós-fechamento)",tipo:"aumento",cor:"#FF7A00"},
                {data:"29/12/2026",acao:"🔴 Santander: 9ª tentativa Unlimited (dívidas quitadas!)",tipo:"upgrade",cor:T.green},
                {data:"05/02/2027",acao:"🔴 Santander: 4º aumento AAdvantage (90 dias, pós-fechamento)",tipo:"aumento",cor:"#E11931"},
                {data:"05/02/2027",acao:"🔺 Bradesco: 1º aumento Nanquim (pós-quitação) + 🟠 Itaú: Personnalité",tipo:"upgrade",cor:T.cyan},
                {data:"Mar/2027",acao:"🔺 Bradesco: Aeternum. TODOS os cartões em nível máximo.",tipo:"final",cor:T.green}
              ].map(function(ev,i){var ck="coach_card_cal_"+i;var on=!!(ratingMes[ck]);return <div key={i} style={{display:"flex",gap:8,marginBottom:0,opacity:on?0.55:1,transition:"opacity 0.2s"}}>
                <button onClick={function(){togRatingTask(ck)}} style={{width:18,height:18,borderRadius:"50%",border:"1.5px solid "+(on?T.green:ev.cor),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1,transition:"all 0.2s"}}>{on&&<Check size={9} color="#020208" />}</button>
                <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:8}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:on?T.green:ev.cor,boxShadow:on?"none":"0 0 6px "+ev.cor+"50",flexShrink:0,marginTop:2}} />
                  {i<16&&<div style={{width:1,flex:1,background:(on?T.green:ev.cor)+"15",minHeight:18}} />}
                </div>
                <div style={{flex:1,paddingBottom:6}}>
                  <div style={{display:"flex",alignItems:"baseline",gap:6}}>
                    <span style={{fontSize:11,fontWeight:800,color:on?T.dim:ev.cor,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",minWidth:55,textDecoration:on?"line-through":"none"}}>{ev.data}</span>
                    <span style={{fontSize:10,fontWeight:700,color:ev.tipo==="aumento"?T.cyan:ev.tipo==="upgrade"?T.gold:ev.tipo==="premium"?"#FFD000":T.green,background:(ev.tipo==="aumento"?T.cyan:ev.tipo==="upgrade"?T.gold:ev.tipo==="premium"?"#FFD000":T.green)+"12",padding:"1px 4px",borderRadius:3}}>{ev.tipo==="aumento"?"AUMENTO":ev.tipo==="upgrade"?"UPGRADE":ev.tipo==="premium"?"⭐ JANELA":"FINAL"}</span>
                    {on&&<span style={{fontSize:10,fontWeight:700,color:T.green,background:T.green+"12",padding:"1px 4px",borderRadius:3}}>FEITO ✓</span>}
                  </div>
                  <div style={{fontSize:11,color:on?T.dim:T.muted,marginTop:1,lineHeight:1.4,textDecoration:on?"line-through":"none"}}>{ev.acao}</div>
                </div>
              </div>;})}
              <div style={{marginTop:8,padding:"8px 10px",background:"rgba(0,0,0,0.15)",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:11,color:T.dim}}>Progresso do calendário</span>
                <span style={{fontSize:12,fontWeight:800,color:T.cyan,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{(function(){var c=0;for(var j=0;j<17;j++){if(ratingMes["coach_card_cal_"+j])c++;}return c})()}/17</span>
              </div>
            </div>

            {/* Meus cartões */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.gold,marginBottom:10}}>💳 MEUS CARTÕES — STATUS ATUAL</div>
              {[
                {nome:"AAdvantage Platinum",banco:"Santander",limite:11343,cor:"#E11931",band:"Mastercard Platinum",papel:"PRINCIPAL — 70-80% dos gastos",usarAte:Math.round(11343*0.3),meta:"Unlimited Visa Infinite",emoji:"✈️"},
                {nome:"Itaú Visa Platinum",banco:"Itaú",limite:18500,cor:"#FF7A00",band:"Visa Platinum",papel:"SECUNDÁRIO — 10-15% dos gastos",usarAte:Math.round(18500*0.3),meta:"Personnalité / Black",emoji:"🟧"},
                {nome:"Bradesco Elo Nanquim",banco:"Bradesco",limite:5000,cor:"#CC092F",band:"Elo Nanquim",papel:"MANUTENÇÃO — 1-2 compras/mês",usarAte:Math.round(5000*0.3),meta:"Aeternum / Prime",emoji:"🔺"}
              ].map(function(card,i){return <div key={i} style={{marginBottom:10,borderRadius:14,padding:14,background:"linear-gradient(135deg, "+card.cor+"08, rgba(0,0,0,0.2))",border:"1px solid "+card.cor+"20",position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",top:-15,right:-15,width:60,height:60,borderRadius:"50%",background:card.cor+"06"}} />
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,position:"relative"}}>
                  <span style={{fontSize:20}}>{card.emoji}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,fontWeight:800,color:card.cor}}>{card.nome}</div>
                    <div style={{fontSize:11,color:T.dim}}>{card.band} • {card.banco}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:13,fontWeight:800,color:T.text,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(card.limite)}</div>
                    <div style={{fontSize:10,color:T.dim}}>limite</div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                  <div style={{background:"rgba(0,0,0,0.2)",borderRadius:8,padding:"6px 8px"}}>
                    <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>USAR ATÉ (30%)</div>
                    <div style={{fontSize:12,fontWeight:700,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(card.usarAte)}</div>
                  </div>
                  <div style={{background:"rgba(0,0,0,0.2)",borderRadius:8,padding:"6px 8px"}}>
                    <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>META UPGRADE</div>
                    <div style={{fontSize:11,fontWeight:700,color:card.cor}}>{card.meta}</div>
                  </div>
                </div>
                <div style={{marginTop:6,fontSize:11,color:T.muted,background:"rgba(255,255,255,0.02)",padding:"4px 8px",borderRadius:6}}>📌 {card.papel}</div>
              </div>;})}
            </div>

            {/* Estratégia por cartão */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:"#E11931",marginBottom:10}}>🔴 AADVANTAGE PLATINUM — ESTRATÉGIA</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:8}}>Cartão principal Santander. Toda ação aqui constrói rating para o Unlimited.</div>
              {[
                {t:"Gastar em escada progressiva: +R$ 500/mês",d:"Mês 1: R$ 2.500 → Mês 2: R$ 3.000 → Mês 3: R$ 3.500. Banco vê tendência de crescimento e libera limite.",ic:"📈",k:"coach_card_sant_1"},
                {t:"Pagar fatura INTEGRAL até dia 22 (5 dias antes do vencimento dia 27)",d:"Nunca rotativo. Pagamento antecipado sinaliza disciplina. Vencimento: dia 27.",ic:"⏰",k:"coach_card_sant_2"},
                {t:"HACK: pagar parte da fatura ANTES do fechamento (dia 3)",d:"Gastou R$ 5.000? Pague R$ 3.000 antes do dia 3. Na fatura aparece só R$ 2.000 (17% do limite). Score sobe mais rápido.",ic:"🧠",k:"coach_card_sant_3"},
                {t:"Pedir aumento 2-5 dias PÓS-FECHAMENTO (dia 5-8)",d:"Datas: 05/05, 05/08, 05/10, 05/02/2027. Logo após fatura paga, sistema registra bom pagador.",ic:"📈",k:"coach_card_sant_4"},
                {t:"Cadastrar no Apple Pay / Google Pay / Samsung Pay",d:"Usar por aproximação. Bancos rastreiam como comportamento de cliente premium/tech-savvy.",ic:"📱",k:"coach_card_sant_5"},
                {t:"Fazer 1 compra internacional por mês (mín. US$ 10)",d:"Spotify/iCloud em dólar, por exemplo. Sinaliza perfil viajante premium. Santander prioriza upgrade.",ic:"🌍",k:"coach_card_sant_6"},
                {t:"Cadastrar em 5+ contas recorrentes",d:"Netflix, Spotify, iCloud, gym, seguro. Recorrência cria previsibilidade. Banco vê estabilidade.",ic:"🔄",k:"coach_card_sant_7"},
                {t:"Nunca parcelar em mais de 3x",d:"Parcelamento longo compromete limite e mostra dependência de crédito.",ic:"🚫",k:"coach_card_sant_8"},
                {t:"Pix salário SEMPRE do mesmo remetente/CNPJ",d:"Receber do mesmo CPF/CNPJ todo mês no mesmo dia. O banco mapeia como renda fixa comprovada.",ic:"💰",k:"coach_card_sant_9"},
                {t:"Fazer 10+ transações/mês no cartão",d:"Frequência importa mais que valor. 10 compras de R$ 100 pesam mais que 1 de R$ 1.000.",ic:"🔢",k:"coach_card_sant_10"},
                {t:"Nunca fazer chargeback ou contestação",d:"Mesmo legítimas, contestações prejudicam perfil de crédito interno. Evitar ao máximo.",ic:"⚠️",k:"coach_card_sant_11"},
                {t:"Solicitar Unlimited na janela premium (Out-Nov)",d:"Bancos liberam mais em out-nov (pré-Black Friday). Alvos: 29/10 e 30/11/2026.",ic:"🏆",k:"coach_card_sant_12"}
              ].map(function(item,i){var on=!!(ratingMes[item.k]);return <div key={i} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"7px 0",borderBottom:i<11?"1px solid rgba(255,255,255,0.02)":"none"}}>
                <button onClick={function(){togRatingTask(item.k)}} style={{width:18,height:18,borderRadius:"50%",border:"1.5px solid "+(on?T.green:"#E11931"),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{on&&<Check size={9} color="#020208" />}</button>
                <div style={{flex:1}}><div style={{fontSize:12,fontWeight:on?400:600,color:on?T.dim:T.text,textDecoration:on?"line-through":"none",lineHeight:1.4}}><span style={{marginRight:4}}>{item.ic}</span>{item.t}</div><div style={{fontSize:11,color:T.dim,marginTop:1,lineHeight:1.3}}>{item.d}</div></div>
              </div>;})}
              <div style={{marginTop:6,padding:"6px 10px",background:"rgba(225,25,49,0.04)",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:11,color:T.dim}}>Progresso Santander</span><span style={{fontSize:12,fontWeight:800,color:"#E11931",fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{(function(){var c=0;for(var j=1;j<=12;j++){if(ratingMes["coach_card_sant_"+j])c++;}return c})()}/12</span></div>
            </div>

            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:"#FF7A00",marginBottom:10}}>🟠 ITAÚ PLATINUM — ESTRATÉGIA</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:8}}>Secundário. Manter ativo sem concentrar gastos. Conta histórica = valor.</div>
              {[
                {t:"Usar 10-15% dos gastos (~R$ 600-900/mês)",d:"Compras pontuais. Supermercado, farmácia, gasolina eventual.",ic:"🛒",k:"coach_card_itau_1"},
                {t:"Pagar fatura integral até dia 22 (vencimento dia 27)",d:"Mesmo com uso baixo, pagar 5 dias antes. Pagamento antecipado conta.",ic:"⏰",k:"coach_card_itau_2"},
                {t:"Usar até R$ 5.550 (30% de R$ 18.500)",d:"Nunca ultrapassar 30% de utilização.",ic:"📊",k:"coach_card_itau_3"},
                {t:"Pedir aumento pós-fechamento a cada 6 meses",d:"Datas: 05/06/2026 e 05/12/2026. Pedir 2 dias após fatura paga, não no dia 29.",ic:"📈",k:"coach_card_itau_4"},
                {t:"Após quitação das dívidas: avaliar Personnalité",d:"Data alvo: 29/01/2027. Renda R$ 21.671 qualifica. Personnalité abre portas para Black/Azul.",ic:"🔑",k:"coach_card_itau_5"},
                {t:"Não fechar a conta em hipótese alguma",d:"Tempo de relacionamento é um dos fatores mais pesados do score.",ic:"⚠️",k:"coach_card_itau_6"}
              ].map(function(item,i){var on=!!(ratingMes[item.k]);return <div key={i} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"6px 0",borderBottom:i<5?"1px solid rgba(255,255,255,0.02)":"none"}}>
                <button onClick={function(){togRatingTask(item.k)}} style={{width:16,height:16,borderRadius:"50%",border:"1.5px solid "+(on?T.green:"#FF7A00"),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{on&&<Check size={8} color="#020208" />}</button>
                <div style={{flex:1}}><div style={{fontSize:11,fontWeight:on?400:600,color:on?T.dim:T.muted,textDecoration:on?"line-through":"none",lineHeight:1.4}}><span style={{marginRight:3}}>{item.ic}</span>{item.t}</div><div style={{fontSize:11,color:T.dim,marginTop:1}}>{item.d}</div></div>
              </div>;})}
              <div style={{marginTop:6,padding:"6px 10px",background:"rgba(255,122,0,0.04)",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:11,color:T.dim}}>Progresso Itaú</span><span style={{fontSize:12,fontWeight:800,color:"#FF7A00",fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{(function(){var c=0;for(var j=1;j<=6;j++){if(ratingMes["coach_card_itau_"+j])c++;}return c})()}/6</span></div>
            </div>

            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:"#CC092F",marginBottom:10}}>🔺 BRADESCO ELO NANQUIM — ESTRATÉGIA</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:8}}>Manutenção pura. Manter vivo para diversidade bancária.</div>
              {[
                {t:"Fazer 1-2 compras pequenas por mês (R$ 100-300)",d:"Apenas para manter o cartão ativo. Farmácia, padaria.",ic:"🛒",k:"coach_card_brad_1"},
                {t:"Pagar fatura integral até dia 22 (vencimento dia 27)",d:"Sempre 100%. Nunca rotativo neste cartão.",ic:"⏰",k:"coach_card_brad_2"},
                {t:"Usar até R$ 1.500 (30% de R$ 5.000)",d:"Controle rígido. Cartão de manutenção, não de consumo.",ic:"📊",k:"coach_card_brad_3"},
                {t:"Após quitação Empr. Bradesco: pedir aumento",d:"Data fixa: 29/01/2027 (1º mês após quitação em dez/26). Solicitar R$ 10-15k.",ic:"📈",k:"coach_card_brad_4"},
                {t:"Avaliar Bradesco Aeternum no futuro",d:"Data alvo: Mar/2027+. Concorrente do Unlimited. Salas VIP ilimitadas + LoungeKey.",ic:"🏆",k:"coach_card_brad_5"}
              ].map(function(item,i){var on=!!(ratingMes[item.k]);return <div key={i} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"6px 0",borderBottom:i<4?"1px solid rgba(255,255,255,0.02)":"none"}}>
                <button onClick={function(){togRatingTask(item.k)}} style={{width:16,height:16,borderRadius:"50%",border:"1.5px solid "+(on?T.green:"#CC092F"),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{on&&<Check size={8} color="#020208" />}</button>
                <div style={{flex:1}}><div style={{fontSize:11,fontWeight:on?400:600,color:on?T.dim:T.muted,textDecoration:on?"line-through":"none",lineHeight:1.4}}><span style={{marginRight:3}}>{item.ic}</span>{item.t}</div><div style={{fontSize:11,color:T.dim,marginTop:1}}>{item.d}</div></div>
              </div>;})}
              <div style={{marginTop:6,padding:"6px 10px",background:"rgba(204,9,47,0.04)",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:11,color:T.dim}}>Progresso Bradesco</span><span style={{fontSize:12,fontWeight:800,color:"#CC092F",fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{(function(){var c=0;for(var j=1;j<=5;j++){if(ratingMes["coach_card_brad_"+j])c++;}return c})()}/5</span></div>
            </div>

            {/* Regras de ouro */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.gold,marginBottom:10}}>👑 REGRAS DE OURO — USO DE CARTÃO DE CRÉDITO</div>
              {[
                {titulo:"Utilização máxima: 30% do limite",desc:"O fator mais pesado na análise de crédito. Acima de 30% você é visto como dependente do crédito. Acima de 50% é sinal vermelho. Ideal: 10-25%.",ic:"📊"},
                {titulo:"Pagar SEMPRE integral, NUNCA rotativo",desc:"Rotativo é a maior armadilha. Juros de 15% ao mês. Um único mês de rotativo destrói meses de bom histórico.",ic:"🚫"},
                {titulo:"Pagar até dia 22 (5 dias ANTES do vencimento dia 27)",desc:"Pagamento antecipado libera limite antes e sinaliza ao banco que você tem caixa. Nunca esperar o dia 27.",ic:"⏰"},
                {titulo:"Concentrar gastos em 1 cartão principal",desc:"O banco que recebe 70-80% dos seus gastos te vê como cliente premium. Pulverizar entre vários cartões enfraquece todos.",ic:"🎯"},
                {titulo:"Usar para gastos recorrentes",desc:"Netflix, Spotify, academia, celular, seguros. Recorrência cria previsibilidade. O banco vê estabilidade.",ic:"🔄"},
                {titulo:"Nunca parcelar acima de 3x",desc:"Parcelamento longo (10x, 12x) compromete limite por meses. Prefira à vista ou no máximo 3x sem juros.",ic:"💰"},
                {titulo:"Solicitar aumento a cada 90 dias",desc:"Pelo app ou gerente. Mesmo que negado, a solicitação mostra ambição. Limite crescente = sinal de confiança.",ic:"📈"},
                {titulo:"Fazer pelo menos 8-10 transações/mês",desc:"Frequência de uso importa mais que valor. 10 compras de R$ 100 pesam mais que 1 compra de R$ 1.000.",ic:"🔢"},
                {titulo:"Nunca estourar o limite",desc:"Ultrapassar o limite (mesmo em R$ 1) é registrado como incidente. Configure alertas em 70% e 90% do limite.",ic:"⚠️"},
                {titulo:"Evitar saques no crédito",desc:"Saque no cartão de crédito tem taxa altíssima e é interpretado como desespero financeiro. Nunca fazer.",ic:"🏧"},
                {titulo:"Compras grandes: usar mas quitar na fatura",desc:"Eletrodomésticos, passagens. Mostra poder de compra, mas quite na fatura integral. Sem parcelamento.",ic:"🛍️"},
                {titulo:"Upgrade é consequência, não pedido",desc:"Quando o banco vê: uso consistente + pagamento integral + limite crescente + investimentos, o upgrade vem até você.",ic:"🏆"}
              ].map(function(regra,i){return <div key={i} style={{display:"flex",gap:10,padding:"8px 0",borderBottom:i<11?"1px solid rgba(255,255,255,0.02)":"none"}}>
                <div style={{width:28,height:28,borderRadius:8,background:T.gold+"10",border:"1px solid "+T.gold+"15",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:12}}>{regra.ic}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.text,lineHeight:1.3}}>{regra.titulo}</div>
                  <div style={{fontSize:11,color:T.dim,marginTop:2,lineHeight:1.5}}>{regra.desc}</div>
                </div>
              </div>;})}
            </div>

            {/* Utilização em tempo real */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.cyan,marginBottom:10}}>📊 UTILIZAÇÃO EM TEMPO REAL</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:10}}>Digite quanto já gastou no cartão este mês. Verde &lt; 20%, Amarelo 20-30%, Vermelho &gt; 30%.</div>
              {[
                {nome:"AAdvantage",key:"sant",limite:cardLimits.sant,cor:"#E11931"},
                {nome:"Itaú Platinum",key:"itau",limite:cardLimits.itau,cor:"#FF7A00"},
                {nome:"Bradesco Nanquim",key:"brad",limite:cardLimits.brad,cor:"#CC092F"}
              ].map(function(c,i){
                var gasto=cardSpend[c.key]||0;
                var pctUso=c.limite>0?Math.round(gasto/c.limite*100):0;
                var corBarra=pctUso<20?T.green:pctUso<=30?T.gold:T.red;
                var status=pctUso<20?"IDEAL ✓":pctUso<=30?"ATENÇÃO":"PERIGO!";
                return <div key={i} style={{marginBottom:12,padding:12,borderRadius:12,background:"rgba(0,0,0,0.15)",border:"1px solid "+c.cor+"15"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <span style={{fontSize:12,fontWeight:700,color:c.cor}}>{c.nome}</span>
                    <span style={{fontSize:11,fontWeight:700,color:corBarra,background:corBarra+"15",padding:"2px 6px",borderRadius:4}}>{status}</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:11,color:T.dim}}>Gasto:</span>
                    <input type="number" placeholder="0" value={gasto||""} onChange={function(e){var v=e.target.value?parseInt(e.target.value):0;setCardSpend(function(p){var n=Object.assign({},p);n[c.key]=v;return n})}} style={{flex:1,background:"rgba(0,0,0,0.3)",border:"1px solid "+corBarra+"30",borderRadius:8,padding:"6px 10px",color:corBarra,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontSize:14,fontWeight:700,textAlign:"center",outline:"none",maxWidth:120}} />
                    <span style={{fontSize:12,color:T.dim}}>de</span>
                    <span style={{fontSize:12,fontWeight:700,color:T.muted,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(c.limite)}</span>
                  </div>
                  <div style={{marginTop:6,height:6,borderRadius:6,background:"rgba(255,255,255,0.04)",overflow:"hidden"}}>
                    <div style={{height:"100%",borderRadius:6,background:corBarra,width:Math.min(pctUso,100)+"%",transition:"width 0.3s",boxShadow:"0 0 8px "+corBarra+"30"}} />
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                    <span style={{fontSize:11,color:T.dim}}>Utilização: <strong style={{color:corBarra}}>{pctUso}%</strong></span>
                    <span style={{fontSize:11,color:T.dim}}>Disponível: <strong style={{color:T.muted,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(Math.max(c.limite-gasto,0))}</strong></span>
                  </div>
                </div>;
              })}
            </div>

            {/* Histórico de limites */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.purple,marginBottom:10}}>📈 HISTÓRICO DE LIMITES</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:10}}>Atualize os limites quando conseguir aumento. Acompanhe a evolução.</div>
              {[
                {nome:"AAdvantage",key:"sant",cor:"#E11931"},
                {nome:"Itaú Platinum",key:"itau",cor:"#FF7A00"},
                {nome:"Bradesco Nanquim",key:"brad",cor:"#CC092F"}
              ].map(function(c,i){
                var lim=cardLimits[c.key]||0;
                return <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 0",borderBottom:i<2?"1px solid rgba(255,255,255,0.03)":"none"}}>
                  <div style={{width:4,height:24,borderRadius:2,background:c.cor,flexShrink:0}} />
                  <span style={{fontSize:12,fontWeight:600,color:T.muted,minWidth:100}}>{c.nome}</span>
                  <input type="number" value={lim||""} onChange={function(e){var v=e.target.value?parseInt(e.target.value):0;setCardLimits(function(p){var n=Object.assign({},p);n[c.key]=v;return n})}} style={{flex:1,background:"rgba(0,0,0,0.3)",border:"1px solid "+c.cor+"20",borderRadius:8,padding:"5px 10px",color:c.cor,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontSize:13,fontWeight:700,textAlign:"center",outline:"none",maxWidth:120}} />
                </div>;
              })}
              <div style={{marginTop:8,fontSize:11,color:T.dim,lineHeight:1.5}}>💡 Dica: atualize após cada aprovação de aumento. Acompanhe se os limites estão crescendo a cada 90 dias (Santander) e 6 meses (Itaú).</div>
            </div>

            {/* Checklist pré-fechamento */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.orange,marginBottom:10}}>📋 CHECKLIST PRÉ-FECHAMENTO (DIA 1-3)</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:10}}>Faça ANTES do dia 3 (fechamento) para reduzir utilização reportada ao Serasa.</div>
              {[
                {t:"Verificar total gasto no AAdvantage este ciclo",d:"Abrir app Santander → cartões → fatura aberta. Anotar valor.",k:"coach_prefecha_1"},
                {t:"Se gasto > 30% do limite: pagar antecipado a diferença",d:"Pagar parte da fatura ANTES do fechamento. Ex: gastou R$ 5k, pague R$ 3k → fatura fecha em R$ 2k.",k:"coach_prefecha_2"},
                {t:"Verificar Itaú: gasto dentro de 30% (R$ 5.550)?",d:"Se não, pagar antecipado também. Mesmo hack funciona em qualquer banco.",k:"coach_prefecha_3"},
                {t:"Confirmar que nenhum cartão está acima de 30%",d:"Verificar os 3 cartões. Todos devem fechar abaixo de 30% de utilização.",k:"coach_prefecha_4"},
                {t:"Não fazer compras grandes nas 48h antes do fechamento",d:"Compra grande no dia 2-3 não dá tempo de pagar antes. Aguardar dia 4.",k:"coach_prefecha_5"}
              ].map(function(item,i){var on=!!(ratingMes[item.k]);return <div key={i} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"6px 0",borderBottom:i<4?"1px solid rgba(255,255,255,0.02)":"none"}}>
                <button onClick={function(){togRatingTask(item.k)}} style={{width:18,height:18,borderRadius:"50%",border:"1.5px solid "+(on?T.green:T.orange),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{on&&<Check size={9} color="#020208" />}</button>
                <div style={{flex:1}}><div style={{fontSize:12,fontWeight:on?400:600,color:on?T.dim:T.text,textDecoration:on?"line-through":"none",lineHeight:1.4}}>{item.t}</div><div style={{fontSize:11,color:T.dim,marginTop:1,lineHeight:1.3}}>{item.d}</div></div>
              </div>;})}
            </div>

            {/* Monitoramento Multi-birô */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.green,marginBottom:10}}>🔍 MONITORAMENTO MULTI-BIRÔ</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:10}}>O Santander pode consultar qualquer birô. Monitore todos, não só o Serasa.</div>
              {[
                {t:"Consultar Serasa Score (serasa.com.br)",d:"Score principal. Gratuito. Consultar toda semana.",k:"coach_biro_1",cor:T.cyan},
                {t:"Consultar Boa Vista SCPC (boavistaservicos.com.br)",d:"Segundo birô mais consultado. Score pode ser diferente do Serasa.",k:"coach_biro_2",cor:T.purple},
                {t:"Consultar Quod (quod.com.br)",d:"Birô mais novo, criado pelos 5 maiores bancos. Santander é sócio!",k:"coach_biro_3",cor:T.gold},
                {t:"Assinar Serasa Premium (R$ 23,90/mês)",d:"Monitoramento em tempo real, alertas de consulta no CPF, selo premium visível aos bancos.",k:"coach_biro_4",cor:T.green},
                {t:"Acessar Registrato BACEN (mensalmente)",d:"Único lugar que mostra TODAS as dívidas, contas e chaves Pix do CPF.",k:"coach_biro_5",cor:T.cyan}
              ].map(function(item,i){var on=!!(ratingMes[item.k]);return <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:i<4?"1px solid rgba(255,255,255,0.02)":"none"}}>
                <button onClick={function(){togRatingTask(item.k)}} style={{width:18,height:18,borderRadius:"50%",border:"1.5px solid "+(on?T.green:item.cor),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{on&&<Check size={9} color="#020208" />}</button>
                <span style={{fontSize:11,color:on?T.dim:T.muted,textDecoration:on?"line-through":"none",lineHeight:1.4,flex:1}}>{item.t}</span>
              </div>;})}
            </div>

            {/* Upgrade path */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.cyan,marginBottom:10}}>🚀 CAMINHO DE UPGRADE</div>
              {[
                {de:"AAdvantage Platinum",para:"Santander Unlimited",quando:"29/10/2026 (1ª tentativa) → 30/11 → 29/12",requisitos:"8+ meses Select, R$ 100k invest., score 850+, uso consistente",cor:"#E11931",k:"coach_upgrade_sant"},
                {de:"Itaú Platinum",para:"Personnalité → Black",quando:"29/01/2027 (após quitação dívidas dez/26)",requisitos:"Renda R$ 21.671 qualifica. Investir no Itaú ou usar Open Finance.",cor:"#FF7A00",k:"coach_upgrade_itau"},
                {de:"Bradesco Nanquim",para:"Aeternum / Prime",quando:"Mar/2027+ (após 3 meses sem dívida)",requisitos:"Quitar empréstimo. Pedir aumento limite. Construir relacionamento.",cor:"#CC092F",k:"coach_upgrade_brad"}
              ].map(function(path,i){var ck=path.k;var on=!!(ratingMes[ck]);var stKey=ck+"_status";var stVal=ratingMes[stKey]||"pendente";return <div key={i} style={{marginBottom:8,borderRadius:12,padding:12,background:"linear-gradient(135deg, "+path.cor+"06, rgba(0,0,0,0.15))",border:"1px solid "+(on?T.green:path.cor)+"15"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                  <button onClick={function(){togRatingTask(ck)}} style={{width:20,height:20,borderRadius:"50%",border:"2px solid "+(on?T.green:path.cor),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all 0.2s"}}>{on&&<Check size={10} color="#020208" />}</button>
                  <div style={{fontSize:12,fontWeight:700,color:on?T.dim:path.cor,textDecoration:on?"line-through":"none"}}>{path.de}</div>
                  <span style={{fontSize:12,color:T.dim}}>→</span>
                  <div style={{fontSize:12,fontWeight:800,color:on?T.green:T.text}}>{path.para}</div>
                  <select value={stVal} onChange={function(e){var rm2=Object.assign({},db.ratingMensal||{});var rk2=ano+"-"+String(mes).padStart(2,"0");rm2[rk2]=Object.assign({},rm2[rk2]||{});rm2[rk2][stKey]=e.target.value;sv(Object.assign({}, db, {ratingMensal:rm2}))}} style={{marginLeft:"auto",background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:6,padding:"2px 6px",color:stVal==="aprovado"?T.green:stVal==="negado"?T.red:stVal==="analise"?T.gold:T.dim,fontSize:10,fontWeight:700,outline:"none",fontFamily:"inherit"}}>
                    <option value="pendente">Pendente</option>
                    <option value="negado">Negado</option>
                    <option value="analise">Análise</option>
                    <option value="aprovado">Aprovado!</option>
                  </select>
                </div>
                <div style={{fontSize:11,color:T.dim,lineHeight:1.4,marginLeft:28}}>📅 {path.quando}</div>
                <div style={{fontSize:11,color:T.muted,marginTop:2,lineHeight:1.4,marginLeft:28}}>📋 {path.requisitos}</div>
              </div>;})}
            </div>
          </div>}

          {/* ═══ TRACKER ═══ */}
          {coachSub==="tracker" && <div>
            {/* Score input */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.cyan,marginBottom:8}}>📊 SCORE SERASA — {MSF[mes-1]} {ano}</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:8}}>Digite o score consultado neste mês</div>
              <input type="number" placeholder="Ex: 763" value={scoreInput||""} onChange={function(e){setScoreInput(e.target.value?parseInt(e.target.value):0)}} style={{width:"100%",background:"rgba(0,0,0,0.3)",border:"1px solid rgba(0,229,255,0.12)",borderRadius:10,padding:"8px 12px",color:T.cyan,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontSize:18,fontWeight:700,textAlign:"center",outline:"none"}} />
              <div style={{marginTop:10,display:"flex",justifyContent:"space-between",padding:"6px 10px",background:"rgba(0,0,0,0.15)",borderRadius:8}}>
                <span style={{fontSize:11,color:T.dim}}>Início (ABR/26)</span>
                <span style={{fontSize:12,fontWeight:700,color:T.cyan,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>763 pts</span>
              </div>
              <div style={{marginTop:6,display:"flex",justifyContent:"space-between",padding:"6px 10px",background:"rgba(0,0,0,0.15)",borderRadius:8}}>
                <span style={{fontSize:11,color:T.dim}}>Atual</span>
                <span style={{fontSize:12,fontWeight:700,color:scoreInput>=800?T.green:scoreInput>=700?T.gold:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{scoreInput||"—"} pts</span>
              </div>
              <div style={{marginTop:6,display:"flex",justifyContent:"space-between",padding:"6px 10px",background:scoreInput>=800?"rgba(0,255,136,0.04)":"rgba(255,208,0,0.04)",borderRadius:8}}>
                <span style={{fontSize:11,color:T.dim}}>Status</span>
                <span style={{fontSize:12,fontWeight:700,color:scoreInput>=800?T.green:T.gold}}>{scoreInput>=900?"EXCELENTE":scoreInput>=800?"BOM":scoreInput>=700?"CONSTRUINDO":"CRÍTICO"}</span>
              </div>
            </div>

            {/* Patrimônio */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.purple,marginBottom:8}}>💎 PATRIMÔNIO SANTANDER</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:8}}>Saldo total investido no Santander</div>
              <input type="number" placeholder="Ex: 25000" value={patrimInput||""} onChange={function(e){setPatrimInput(e.target.value?parseInt(e.target.value):0)}} style={{width:"100%",background:"rgba(0,0,0,0.3)",border:"1px solid rgba(184,77,255,0.15)",borderRadius:10,padding:"8px 12px",color:T.purple,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",fontSize:18,fontWeight:700,textAlign:"center",outline:"none"}} />
              <div style={{marginTop:8}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:11,color:T.dim}}>Meta: R$ 100.000</span>
                  <span style={{fontSize:11,fontWeight:700,color:T.purple,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(patrimInput||0)} / R$ 100k</span>
                </div>
                <PB value={patrimInput||0} max={100000} color={T.purple} h={6} />
              </div>
            </div>

            {/* Card attempt log */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.gold,marginBottom:8}}>📌 TENTATIVAS DE CARTÃO</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:10}}>1 tentativa/mês, dia 29 (ou próximo útil)</div>
              {CARD_DATES.map(function(dt,i){var tentKey="_tent_sant_"+i;var tentVal=ratingMes[tentKey]||"";return <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",marginBottom:3,borderRadius:10,background:"rgba(255,255,255,0.015)",border:"1px solid rgba(255,255,255,0.03)"}}>
                <span style={{fontSize:11,fontWeight:700,color:T.gold,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",width:36}}>{dt}</span>
                <span style={{fontSize:11,color:T.dim,flex:1}}>Unlimited</span>
                <select value={tentVal} onChange={function(e){updRatingTentativa("sant_"+i,e.target.value)}} style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:6,padding:"2px 6px",color:tentVal==="aprovado"?T.green:tentVal==="negado"?T.red:tentVal==="analise"?T.gold:T.dim,fontSize:11,fontWeight:700,outline:"none",fontFamily:"inherit"}}>
                  <option value="">Pendente</option>
                  <option value="negado">Negado</option>
                  <option value="analise">Análise</option>
                  <option value="aprovado">Aprovado</option>
                </select>
              </div>;})}
            </div>

            {/* Rotina semanal */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.cyan,marginBottom:8}}>🔄 ROTINA SEMANAL</div>
              {[0,1,2,3].map(function(sem){return <div key={sem} style={{background:"rgba(0,0,0,0.12)",borderRadius:10,padding:10,marginBottom:4}}>
                <div style={{fontSize:11,fontWeight:700,color:T.cyan,letterSpacing:1.5,marginBottom:6}}>SEMANA {sem+1}</div>
                {WEEKLY_TASKS.map(function(w,wi){return <div key={wi} style={{marginBottom:3}}>
                  <div style={{fontSize:11,color:T.purple,fontWeight:600,marginBottom:2}}>{w.day}</div>
                  {w.tasks.map(function(task,ti){var k="coach_wk_"+wi+"_"+ti+"_"+sem;var on=!!(ratingMes[k]);return <div key={ti} style={{display:"flex",alignItems:"center",gap:6,padding:"3px 0"}}><button onClick={function(){togRatingTask(k)}} style={{width:14,height:14,borderRadius:"50%",border:"1.5px solid "+(on?T.green:T.cyan),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{on&&<Check size={7} color="#020208" />}</button><span style={{fontSize:11,color:on?T.dim:T.muted,textDecoration:on?"line-through":"none"}}>{task}</span></div>;})}
                </div>;})}
              </div>;})}
            </div>

            {/* Rating history (existing) */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:ratingColor,marginBottom:8}}>📈 EVOLUÇÃO DO RATING INTERNO</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:10}}>
                {[{l:"Score geral",v:ratingScore+"/100",c:ratingColor},{l:"Santander",v:planoSantander.score+"/100",c:"#E11931"},{l:"Variação",v:(ratingDelta>=0?"+":"")+ratingDelta+" pts",c:ratingDeltaColor}].map(function(x,i){return <div key={i} style={{padding:"8px 10px",borderRadius:10,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.04)",textAlign:"center"}}><div style={{fontSize:11,color:T.dim,letterSpacing:0.4,fontWeight:600}}>{x.l.toUpperCase()}</div><div style={{fontSize:13,fontWeight:800,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",color:x.c}}>{x.v}</div></div>;})}
              </div>
              <PB value={ratingScore} max={100} color={ratingColor} h={6} />
            </div>
          </div>}

          {/* ═══ DÍVIDAS ═══ */}
          {coachSub==="dividas" && <div>
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.red,marginBottom:8}}>📉 CASCATA DE DÍVIDAS</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:12}}>31 parcelas ativas em ABR/26. Veja quando cada uma termina.</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:12}}>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}><div style={{fontSize:10,color:T.dim}}>TOTAL ABR</div><div style={{fontSize:13,fontWeight:800,color:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>R$ 4.777</div></div>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}><div style={{fontSize:10,color:T.dim}}>PARCELAS</div><div style={{fontSize:13,fontWeight:800,color:T.gold,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>31</div></div>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}><div style={{fontSize:10,color:T.dim}}>LIVRE EM</div><div style={{fontSize:13,fontWeight:800,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>DEZ/26</div></div>
              </div>
              {debtEntries.map(function(group,gi){var isLast=gi===debtEntries.length-1;return <div key={gi} style={{marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:isLast?T.green:T.gold,boxShadow:"0 0 6px "+(isLast?T.green:T.gold)+"50"}} />
                  <span style={{fontSize:11,fontWeight:800,color:isLast?T.green:T.gold,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{group.moLabel}</span>
                  <div style={{flex:1,height:1,background:"rgba(255,255,255,0.03)"}} />
                  <span style={{fontSize:11,fontWeight:700,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>+{f$(group.total)}/mês</span>
                </div>
                <div style={{marginLeft:16,borderLeft:"1px solid rgba(255,255,255,0.03)",paddingLeft:10}}>
                  {group.items.map(function(p,pi){return <div key={pi} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",borderBottom:pi<group.items.length-1?"1px solid rgba(255,255,255,0.015)":"none"}}><span style={{fontSize:11,color:p.s?T.red:T.muted}}>{p.n}{p.s?" ⚠️":""}</span><span style={{fontSize:11,color:T.dim,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(p.v)}</span></div>;})}
                </div>
              </div>;})}
            </div>

            {/* Bar chart */}
            <div style={coachBx}>
              <div style={{fontSize:11,fontWeight:700,color:T.dim,letterSpacing:1,marginBottom:6}}>PARCELAS RESTANTES POR MÊS</div>
              <div style={{display:"flex",gap:2,alignItems:"flex-end",height:55}}>
                {Array.from({length:10},function(_,i){var m2=i+1;var val=PARCELAS_DATA.filter(function(p){return p.t>=m2}).reduce(function(s,p){return s+p.v},0);var h=Math.max((val/4777)*50,2);var c=val>3000?T.red:val>1000?T.gold:val>0?T.orange:T.green;return <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>{val>0&&<div style={{fontSize:10,color:c,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{(val/1000).toFixed(1)}k</div>}<div style={{width:"100%",height:h,borderRadius:3,background:c}} /><div style={{fontSize:10,color:T.dim}}>{["ABR","MAI","JUN","JUL","AGO","SET","OUT","NOV","DEZ","JAN"][i]}</div></div>;})}
              </div>
            </div>
          </div>}

          {/* ═══ REGRAS ═══ */}
          {coachSub==="regras" && <div>
            {/* Proibido */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.red,marginBottom:8}}>🚫 AUDITORIA MENSAL — PROIBIDO</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:8}}>Marque TODOS para confirmar que não se sabotou</div>
              {PROIBIDO_ITEMS.map(function(item,i){var k="coach_pb_"+i;var on=!!(ratingMes[k]);return <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:i<PROIBIDO_ITEMS.length-1?"1px solid rgba(255,255,255,0.02)":"none"}}><button onClick={function(){togRatingTask(k)}} style={{width:16,height:16,borderRadius:"50%",border:"1.5px solid "+(on?T.green:T.red),background:on?T.green:"transparent",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{on&&<Check size={8} color="#020208" />}</button><span style={{fontSize:11,color:on?T.green:T.muted,lineHeight:1.4}}>{item}</span>{on&&<span style={{fontSize:10,fontWeight:700,color:T.green,background:T.green+"12",padding:"1px 4px",borderRadius:3,marginLeft:"auto"}}>OK</span>}</div>;})}
              <div style={{textAlign:"center",marginTop:8}}>
                <span style={{fontSize:12,fontWeight:800,color:PROIBIDO_ITEMS.every(function(_,i){return !!(ratingMes["coach_pb_"+i])})?T.green:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{PROIBIDO_ITEMS.filter(function(_,i){return !!(ratingMes["coach_pb_"+i])}).length}/{PROIBIDO_ITEMS.length}</span>
                <span style={{fontSize:11,color:T.dim,marginLeft:6}}>{PROIBIDO_ITEMS.every(function(_,i){return !!(ratingMes["coach_pb_"+i])})?"MÊS LIMPO! ✓":"itens pendentes"}</span>
              </div>
            </div>

            {/* Melhorias avançadas */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.purple,marginBottom:8}}>🧠 MELHORIAS AVANÇADAS</div>
              {MELHORIAS.map(function(item,i){return <div key={i} style={{display:"flex",gap:8,padding:"7px 0",borderBottom:i<MELHORIAS.length-1?"1px solid rgba(255,255,255,0.02)":"none"}}><span style={{fontSize:13,flexShrink:0}}>{item.ic}</span><div><div style={{fontSize:12,fontWeight:700,color:T.text}}>{item.t}</div><div style={{fontSize:11,color:T.dim,marginTop:2,lineHeight:1.4}}>{item.d}</div></div></div>;})}
            </div>

            {/* Onde colocar o dinheiro */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.cyan,marginBottom:8}}>💎 ONDE COLOCAR O DINHEIRO</div>
              {[{t:"CC Santander (almofada)",v:"R$ 8.000",d:"Nunca mexer. Saldo médio estável.",c:T.cyan},{t:"CDB Liquidez (dia 26)",v:"R$ 2.000/mês",d:"40% do aporte. ~14% a.a.",c:T.cyan},{t:"LCI/LCA (dia 26)",v:"R$ 3.000/mês",d:"60% do aporte. Isento IR.",c:T.purple},{t:"Cartão Santander (80%)",v:"~R$ 3.360/mês",d:"Todo gasto possível. AAdvantage→Unique→Unlimited.",c:T.gold},{t:"Previdência PGBL",v:"R$ 100+/mês",d:"Deduz IR + produto relacionamento.",c:T.green},{t:"Seguro",v:"R$ 40-80/mês",d:"+1 produto = +rating.",c:T.green}].map(function(item,i){return <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:"5px 0",borderBottom:i<5?"1px solid rgba(255,255,255,0.02)":"none"}}><div><div style={{fontSize:11,fontWeight:600,color:T.muted}}>{item.t}</div><div style={{fontSize:10,color:T.dim,marginTop:1}}>{item.d}</div></div><span style={{fontSize:11,fontWeight:700,color:item.c,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",flexShrink:0,marginLeft:8}}>{item.v}</span></div>;})}
              <div style={{marginTop:8,background:"rgba(255,138,80,0.03)",borderRadius:8,padding:8,borderLeft:"2px solid "+T.orange+"25",opacity:0.7}}>
                <div style={{fontSize:11,fontWeight:600,color:T.orange}}>🔧 Itaú + Bradesco = hibernação</div>
                <div style={{fontSize:11,color:T.dim,marginTop:2}}>R$ 1.000 + R$ 500 nas CCs. 1 compra/mês cada cartão. Pagar parcelas até dez/26.</div>
              </div>
            </div>

            {/* Projeção */}
            <div style={coachBx}>
              <div style={{fontSize:12,fontWeight:800,color:T.cyan,marginBottom:8}}>📈 PROJEÇÃO</div>
              {[{m:"ABR-JUN",d:"Select aberto. Salário portado. R$ 15-20k invest. Score 780+. Elite/Unique.",c:T.cyan},{m:"JUL-SET",d:"R$ 30-40k invest. Score 820+. 5+ meses Select. Solicitar Unlimited.",c:T.purple},{m:"OUT-DEZ",d:"6-8 meses Select. R$ 50-60k. Score 860+. Serasa quitado. UNLIMITED!",c:T.gold},{m:"JAN-MAR 27",d:"Rating máximo. R$ 70k+. Score 900+. Unlimited com anuidade isenta.",c:T.green}].map(function(item,i){return <div key={i} style={{display:"flex",gap:8}}>
                <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:8}}><div style={{width:7,height:7,borderRadius:"50%",background:item.c,boxShadow:"0 0 6px "+item.c+"50"}} />{i<3&&<div style={{width:1,flex:1,background:item.c+"15",minHeight:24}} />}</div>
                <div style={{flex:1,paddingBottom:8}}><div style={{fontSize:11,fontWeight:800,color:item.c,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{item.m}</div><div style={{fontSize:11,color:T.dim,marginTop:2,lineHeight:1.4}}>{item.d}</div></div>
              </div>;})}
            </div>
          </div>}

        </div>;
        })()}

        {}
        {tab==="orc" && <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:7}}><DollarSign size={14} color={T.cyan} /><h2 style={{margin:0,fontSize:15,fontWeight:700}}>Orçamento: {MSF[mes-1]} {ano}</h2></div>
            <button onClick={function(){setModal({type:"cat",title:"Nova Categoria",data:{tipo:"despesa"}})}} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:7,background:T.green,border:"none",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:600}}><Plus size={12} /> Categoria</button>
          </div>

          {}
          <div style={Object.assign({},bx,{marginBottom:12,background:"linear-gradient(135deg,"+T.card+","+T.cyan+"03)"})}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(115px,1fr))",gap:8}}>
              {[{l:"Receita",v:pv.receitaMes,c:T.greenL},{l:"Desp. Lancadas",v:pv.despLancadas,c:T.red},{l:"Total saidas",v:pv.despTotalMes,c:T.orange},{l:"Sobra",v:pv.sobraPrevista,c:pv.sobraPrevista>=0?T.green:T.red},{l:"Até salário",v:pv.aindaPodeGastar,c:pv.aindaPodeGastar>=0?T.green:T.red}].map(function(x,i) {
                return <div key={i} style={mc2}><div style={{fontSize:11,color:T.dim,textTransform:"uppercase",marginBottom:3}}>{x.l}</div><div style={{fontSize:13,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",color:x.c}}>{f$(x.v)}</div></div>;
              })}
            </div>
          </div>

          {}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:8,marginBottom:12}}>
            {pv.porCat.map(function(o,i) {
              var cor = o.projetado > o.orc*1.1 && o.orc > 0 ? T.red : o.projetado > o.orc*0.8 && o.orc > 0 ? T.gold : T.green;
              var ci = catInfo(o.id);
              return <div key={o.id} style={Object.assign({},bx,{padding:12,borderLeft:"3px solid "+(ci.cor||T.dim)})}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontSize:14}}>{ci.emoji}</span><span style={{fontSize:12,fontWeight:700}}>{o.nome}</span><IBtn icon={Edit3} onClick={function(){setModal({type:"cat",title:"Editar Categoria",data:o})}} /></div>
                  <Bd color={cor}>{o.orc > 0 ? pct(o.projetado/o.orc*100) : "--"}</Bd>
                </div>
                <PB value={o.lancado} max={o.orc || o.lancado || 1} color={cor} h={6} />
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3,marginTop:6,fontSize:11}}>
                  <div style={{color:T.dim}}>Realizado: <span style={{color:T.green,fontWeight:600,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(o.realizado)}</span></div>
                  <div style={{color:T.dim,textAlign:"right"}}>Pendente: <span style={{color:T.gold,fontWeight:600,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(o.pendente)}</span></div>
                  <div style={{color:T.dim}}>Projetado: <span style={{color:T.orange,fontWeight:600,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(o.projetado)}</span></div>
                  <div style={{color:T.dim,textAlign:"right"}}>Orcado: <EV value={o.orc} onChange={function(v){updCatOrc(o.id,v)}} /></div>
                </div>
                <div style={{fontSize:11,marginTop:3,color:o.desvioR>=0?T.green:T.red}}>{o.desvioR>=0 ? "Dentro: "+f$(o.desvioR) : "Excesso: "+f$(Math.abs(o.desvioR))+" ("+pct(Math.abs(o.desvioP))+")"}</div>
                
              </div>;
            })}
          </div>

          {}
          {pv.porCat.length > 0 && <div style={bx}>
            <div style={{fontSize:12,fontWeight:700,marginBottom:10}}>Orcado vs Projetado vs Realizado</div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={pv.porCat.filter(function(c){return c.orc>0}).map(function(o){return{name:o.nome.slice(0,7),orc:o.orc,proj:o.projetado,real:o.realizado}})} barGap={1}>
                <defs>
                  <linearGradient id="bOrc" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.blue} stopOpacity={0.5} /><stop offset="100%" stopColor={T.blue} stopOpacity={0.15} /></linearGradient>
                  <linearGradient id="bProj" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.orange} stopOpacity={0.75} /><stop offset="100%" stopColor={T.orange} stopOpacity={0.3} /></linearGradient>
                  <linearGradient id="bReal" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.cyan} stopOpacity={1} /><stop offset="100%" stopColor={T.cyan} stopOpacity={0.5} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 6" stroke={T.cyan+"15"} vertical={false} />
                <XAxis dataKey="name" tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"15"}} tickLine={false} />
                <YAxis tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"15"}} tickLine={false} tickFormatter={fK} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="orc" name="Orcado" fill="url(#bOrc)" radius={[4,4,0,0]} />
                <Bar dataKey="proj" name="Projetado" fill="url(#bProj)" radius={[4,4,0,0]} />
                <Bar dataKey="real" name="Realizado" fill="url(#bReal)" radius={[4,4,0,0]} style={{filter:"drop-shadow(0 0 4px "+T.cyan+"60)"}} />
              </BarChart>
            </ResponsiveContainer>
          </div>}
        </div>}

        {}
        {tab==="assin" && (function(){
          var allAssin = lancEx.filter(function(l){return l.mes===mes && l.ano===ano && (l.cat==="c3" || l.cat==="c15" || (l.cat==="c16" && l.rec))});
          var totalAssin = allAssin.reduce(function(s,l){return s+l.valor},0);
          var receitaMes = lancEx.filter(function(l){return l.mes===mes&&l.ano===ano&&l.tipo==="receita"}).reduce(function(s,l){return s+l.valor},0);
          var pctRenda = receitaMes > 0 ? (totalAssin/receitaMes*100) : 0;
          var anoTotal = totalAssin * 12;
          var totalPago = allAssin.filter(function(l){return l.status==="pago"}).reduce(function(s,l){return s+l.valor},0);
          var totalPend = totalAssin - totalPago;

          // Sub-categories
          var SUB_CATS = [
            {id:"ia",nome:"Inteligência Artificial",emoji:"🤖",cor:"#8B5CF6",keys:["claude","chatgpt"]},
            {id:"stream",nome:"Streaming & Entretenimento",emoji:"🎬",cor:"#EC4899",keys:["streaming","cinemark","spotify"]},
            {id:"fitness",nome:"Fitness & Lazer",emoji:"💪",cor:"#10B981",keys:["totalpass"]},
            {id:"tech",nome:"Tecnologia",emoji:"📱",cor:"#06B6D4",keys:["icloud"]},
            {id:"finance",nome:"Serviços Financeiros",emoji:"🏦",cor:"#FFD000",keys:["santander select","revolut ultra","revolut","serasa"]},
            {id:"milhas",nome:"Milhas",emoji:"✈️",cor:"#0EA5E9",keys:["livelo","smiles","curtai","clube curtai","revpoints"]},
            {id:"anuidades",nome:"Anuidades",emoji:"💳",cor:"#F59E0B",keys:["anuidade"]},
          ];

          var grouped = SUB_CATS.map(function(cat){
            var items = allAssin.filter(function(l){
              var d = (l.desc||"").toLowerCase();
              return cat.keys.some(function(k){return d.indexOf(k)>=0});
            });
            return {cat:cat, items:items, total:items.reduce(function(s,l){return s+l.valor},0)};
          }).filter(function(g){return g.items.length > 0});

          var matchedIds = {};
          grouped.forEach(function(g){g.items.forEach(function(l){matchedIds[l.id]=true})});
          var unmatched = allAssin.filter(function(l){return !matchedIds[l.id]});
          if (unmatched.length > 0) {
            grouped.push({cat:{id:"outros",nome:"Outros",emoji:"📦",cor:"#6B7280",keys:[]}, items:unmatched, total:unmatched.reduce(function(s,l){return s+l.valor},0)});
          }
          grouped.sort(function(a,b){return b.total - a.total});

          var pieData = grouped.map(function(g){return {name:g.cat.nome, value:Math.round(g.total*100)/100, fill:g.cat.cor}});

          // Cartão vs Pix
          var totalCartao = allAssin.filter(function(l){return l.cartaoId}).reduce(function(s,l){return s+l.valor},0);
          var totalPix = totalAssin - totalCartao;

          // Sorted by value
          var sorted = allAssin.slice().sort(function(a,b){return b.valor-a.valor});

          return <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:7}}><Repeat size={14} color={T.purple} /><h2 style={{margin:0,fontSize:15,fontWeight:700}}>Assinaturas</h2></div>
              <span style={{fontSize:12,fontWeight:700,color:T.purple,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{MSF[mes-1]} {ano}</span>
            </div>

            {/* Hero */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:18,background:"linear-gradient(135deg, "+T.card+", "+T.purple+"06)",borderColor:T.purple+"20"})}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:14,padding:"12px 14px",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.5,fontWeight:600}}>TOTAL MENSAL</div>
                  <div style={{fontSize:22,fontWeight:900,color:T.purple,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",marginTop:4}}>{f$(totalAssin)}</div>
                  <div style={{fontSize:11,color:T.dim,marginTop:2}}>{allAssin.length} assinaturas ativas</div>
                </div>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:14,padding:"12px 14px",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.5,fontWeight:600}}>CUSTO ANUAL</div>
                  <div style={{fontSize:22,fontWeight:900,color:T.gold,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",marginTop:4}}>{f$(anoTotal)}</div>
                  <div style={{fontSize:11,color:T.dim,marginTop:2}}>{pctRenda.toFixed(1)}% da renda</div>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>PAGO</div>
                  <div style={{fontSize:13,fontWeight:800,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(totalPago)}</div>
                </div>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>PENDENTE</div>
                  <div style={{fontSize:13,fontWeight:800,color:T.gold,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(totalPend)}</div>
                </div>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>POR DIA</div>
                  <div style={{fontSize:13,fontWeight:800,color:T.orange,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(totalAssin/30)}</div>
                </div>
              </div>
            </div>

            {/* Impacto na renda */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Impacto na Renda</div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:11,color:T.muted}}>Assinaturas vs Renda ({f$(receitaMes)})</span>
                <span style={{fontSize:11,fontWeight:700,color:pctRenda>15?T.red:pctRenda>10?T.gold:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{pctRenda.toFixed(1)}%</span>
              </div>
              <div style={{height:8,borderRadius:8,background:"rgba(255,255,255,0.04)",overflow:"hidden",marginBottom:8}}>
                <div style={{height:"100%",borderRadius:8,background:"linear-gradient(90deg, "+T.purple+", "+(pctRenda>15?T.red:pctRenda>10?T.gold:T.green)+")",width:Math.min(pctRenda,100)+"%",transition:"width 0.5s"}} />
              </div>
              <div style={{padding:"8px 10px",borderRadius:8,background:T.green+"06",border:"1px solid "+T.green+"10"}}>
                <div style={{fontSize:11,color:T.dim}}>Sobra após assinaturas</div>
                <div style={{fontSize:14,fontWeight:800,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(receitaMes - totalAssin)}</div>
              </div>
            </div>

            {/* Pie Chart */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Distribuição por Categoria</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:"45%"}}>
                  <ResponsiveContainer width="100%" height={140}>
                    <PieChart>
                      <Pie data={pieData} dataKey="value" cx="50%" cy="50%" outerRadius={55} innerRadius={28} paddingAngle={2} strokeWidth={0}>
                        {pieData.map(function(entry,idx){return <Cell key={idx} fill={entry.fill} />})}
                      </Pie>
                      <Tooltip contentStyle={{background:"rgba(8,8,20,0.95)",border:"1px solid "+T.cyan+"25",borderRadius:12,fontSize:12,boxShadow:"0 0 30px "+T.cyan+"15, 0 12px 32px rgba(0,0,0,0.5)",backdropFilter:"blur(20px)"}} itemStyle={{color:T.text}} labelStyle={{color:T.cyan,fontWeight:700,letterSpacing:1}} formatter={function(v){return [f$(v),"Valor"]}} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div style={{flex:1}}>
                  {grouped.map(function(g,i){
                    var pctCat = totalAssin>0?(g.total/totalAssin*100):0;
                    return <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                      <div style={{width:8,height:8,borderRadius:4,background:g.cat.cor,flexShrink:0}} />
                      <span style={{fontSize:11,color:T.muted,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{g.cat.nome}</span>
                      <span style={{fontSize:11,fontWeight:700,color:g.cat.cor,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{pctCat.toFixed(0)}%</span>
                    </div>;
                  })}
                </div>
              </div>
            </div>

            {/* Category cards */}
            {grouped.map(function(g,gi){
              return <div key={gi} style={Object.assign({},bx,{marginBottom:10,padding:0,overflow:"hidden"})}>
                <div style={{padding:"12px 16px",background:"linear-gradient(135deg, "+g.cat.cor+"08, transparent)",borderBottom:"1px solid "+g.cat.cor+"10",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:16}}>{g.cat.emoji}</span>
                    <div>
                      <div style={{fontSize:12,fontWeight:800,color:g.cat.cor}}>{g.cat.nome}</div>
                      <div style={{fontSize:11,color:T.dim}}>{g.items.length} item{g.items.length>1?"s":""}</div>
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:14,fontWeight:800,color:g.cat.cor,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(g.total)}</div>
                    <div style={{fontSize:10,color:T.dim}}>{f$(g.total*12)}/ano</div>
                  </div>
                </div>
                <div style={{padding:"4px 12px 8px"}}>
                  {g.items.sort(function(a,b){return b.valor-a.valor}).map(function(l,li){
                    var cardObj = null;
                    if (l.cartaoId) { for (let ci =0;ci<db.cartoes.length;ci++){if(db.cartoes[ci].id===l.cartaoId){cardObj=db.cartoes[ci];break;}} }
                    return <div key={li} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 4px",borderBottom:li<g.items.length-1?"1px solid rgba(255,255,255,0.02)":"none"}}>
                      <div style={{width:3,height:20,borderRadius:2,background:l.status==="pago"?T.green:T.gold,flexShrink:0}} />
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:12,fontWeight:600,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.desc}</div>
                        <div style={{display:"flex",alignItems:"center",gap:4,marginTop:2}}>
                          <span style={{fontSize:10,color:l.status==="pago"?T.green:T.gold,fontWeight:600}}>{l.status==="pago"?"PAGO":"PENDENTE"}</span>
                          {cardObj && <span style={{fontSize:10,color:cardObj.cor,background:cardObj.cor+"12",padding:"0px 4px",borderRadius:3}}>{cardObj.nome.length>18?cardObj.nome.slice(0,18)+"…":cardObj.nome}</span>}
                          {!l.cartaoId && <span style={{fontSize:10,color:T.cyan,background:T.cyan+"12",padding:"0px 4px",borderRadius:3}}>Pix/Boleto</span>}
                        </div>
                      </div>
                      <div style={{textAlign:"right",flexShrink:0}}>
                        <div style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(l.valor)}</div>
                        <div style={{fontSize:10,color:T.dim}}>{f$(l.valor*12)}/ano</div>
                      </div>
                    </div>;
                  })}
                </div>
              </div>;
            })}

            {/* Ranking */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10,color:T.red}}>🔥 Ranking por Valor</div>
              {sorted.map(function(l,i){
                var pctItem = totalAssin>0?(l.valor/totalAssin*100):0;
                return <div key={i} style={{marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                    <span style={{fontSize:12,fontWeight:600,color:T.text}}>{i+1}. {l.desc}</span>
                    <span style={{fontSize:12,fontWeight:700,color:i<3?T.red:T.muted,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(l.valor)} <span style={{fontSize:11,color:T.dim}}>({pctItem.toFixed(1)}%)</span></span>
                  </div>
                  <div style={{height:4,borderRadius:4,background:"rgba(255,255,255,0.03)",overflow:"hidden"}}>
                    <div style={{height:"100%",borderRadius:4,background:i<3?T.red:T.purple,width:pctItem+"%",opacity:1-i*0.06}} />
                  </div>
                </div>;
              })}
            </div>

            {/* Cartão vs Pix */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>💳 Método de Pagamento</div>
              <div style={{display:"flex",gap:8}}>
                <div style={{flex:1,padding:"12px 14px",borderRadius:12,background:T.green+"08",border:"1px solid "+T.green+"15",textAlign:"center"}}>
                  <CreditCard size={16} color={T.green} style={{marginBottom:4}} />
                  <div style={{fontSize:11,color:T.dim}}>No Cartão</div>
                  <div style={{fontSize:16,fontWeight:800,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(totalCartao)}</div>
                  <div style={{fontSize:11,color:T.dim}}>{allAssin.filter(function(l){return l.cartaoId}).length} itens</div>
                </div>
                <div style={{flex:1,padding:"12px 14px",borderRadius:12,background:T.cyan+"08",border:"1px solid "+T.cyan+"15",textAlign:"center"}}>
                  <Wallet size={16} color={T.cyan} style={{marginBottom:4}} />
                  <div style={{fontSize:11,color:T.dim}}>Pix / Boleto</div>
                  <div style={{fontSize:16,fontWeight:800,color:T.cyan,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(totalPix)}</div>
                  <div style={{fontSize:11,color:T.dim}}>{allAssin.filter(function(l){return !l.cartaoId}).length} itens</div>
                </div>
              </div>
              {totalPix > 0 && <div style={{marginTop:8,padding:"8px 10px",borderRadius:8,background:T.gold+"06",border:"1px solid "+T.gold+"10",fontSize:11,color:T.gold}}>💡 Migrar assinaturas de Pix para cartão aumenta transações e constrói rating bancário.</div>}
            </div>

            {/* Projeção anual */}
            <div style={Object.assign({},bx,{padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>📅 Projeção Anual</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                {grouped.map(function(g,i){return <div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 10px",borderRadius:10,background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.03)"}}>
                  <span style={{fontSize:14}}>{g.cat.emoji}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:11,color:T.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{g.cat.nome}</div>
                    <div style={{fontSize:12,fontWeight:700,color:g.cat.cor,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(g.total*12)}</div>
                  </div>
                </div>;})}
              </div>
              <div style={{marginTop:10,padding:"10px 12px",borderRadius:10,background:"linear-gradient(135deg, "+T.purple+"10, "+T.gold+"05)",border:"1px solid "+T.purple+"15",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,fontWeight:700,color:T.text}}>Total Anual</span>
                <span style={{fontSize:18,fontWeight:900,color:T.purple,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(anoTotal)}</span>
              </div>
            </div>
          </div>;
        })()}

        {tab==="parc" && <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:7}}><Landmark size={14} color={T.gold} /><h2 style={{margin:0,fontSize:15,fontWeight:700}}>Parcelamentos: {MSF[mes-1]}</h2></div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <button onClick={function(){setModal({type:"div",title:"Nova Dívida",data:{}})}} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:8,background:"linear-gradient(135deg, "+T.green+", "+T.emerald+")",border:"none",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,boxShadow:"0 4px 12px rgba(16,185,129,0.20)"}}><Plus size={12} /> Nova Dívida</button>
              <div style={{fontSize:18,fontWeight:800,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",color:T.gold}}>{f$(totalParcMes)}</div>
            </div>
          </div>
          <div style={{padding:"10px 16px",borderRadius:10,background:"linear-gradient(135deg,"+T.card+","+T.gold+"06)",border:"1px solid "+T.gold+"15",marginBottom:12,textAlign:"center"}}><span style={{fontSize:12,fontStyle:"italic",color:T.gold}}>"{fraseParc}"</span></div>
          <div style={bx}>
            {parcelas.length===0 ? <div style={{textAlign:"center",padding:24,color:T.dim}}>Nenhuma parcela</div> :
            <div style={{display:"flex",flexDirection:"column",gap:5}}>
              {parcelas.slice().sort(function(a,b){return b.valor-a.valor}).map(function(l) {
                return <div key={l.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 12px",borderRadius:9,background:T.cardAlt,border:"1px solid "+T.border}}>
                  <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600}}>{l.desc}</div><div style={{fontSize:11,color:T.dim,marginTop:2}}>{l.pT>0 ? "Parcela "+l.pA+" de "+l.pT+" - Restam "+(l.pT-l.pA) : ""} <Bd color={l.status==="pago"?T.green:T.gold}>{l.status}</Bd></div></div>
                  <div style={{fontSize:14,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",color:T.gold}}>{f$(l.valor)}</div>
                </div>;
              })}
            </div>}
          </div>

          {}
          {(function() {
            var dados = [];
            for (let off = 0; off < 6; off++) {
              var ref = addMesRef(mes, ano, off);
              var totalMes = 0;
              lancEx.forEach(function(l) {
                if (l.mes === ref.mes && l.ano === ref.ano && (l.tipo === "parcela" || l.pT > 0)) totalMes += l.valor || 0;
              });
              dados.push({nome: MS[ref.mes-1], total: Math.round(totalMes)});
            }
            if (dados.length === 0 || dados[0].total === 0) return null;
            return <div style={Object.assign({},bx,{marginTop:14})}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}><TrendingDown size={14} color={T.gold} /><span style={{fontSize:13,fontWeight:700}}>Reducao de parcelas (6 meses)</span></div>
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={dados}>
                  <defs><linearGradient id="gParc" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={T.gold} stopOpacity={0.3} /><stop offset="95%" stopColor={T.gold} stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid strokeDasharray="2 6" stroke={T.cyan+"15"} vertical={false} />
                  <XAxis dataKey="nome" tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"20"}} tickLine={false} />
                  <YAxis tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"20"}} tickLine={false} tickFormatter={fK} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="total" name="Parcelas/mês" stroke={T.gold} fill="url(#gParc)" strokeWidth={2} dot={{r:3,fill:T.gold,stroke:T.gold,strokeWidth:1}} style={{filter:"drop-shadow(0 0 6px "+T.gold+"70)"}} />
                </AreaChart>
              </ResponsiveContainer>
            </div>;
          })()}

          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:16,marginBottom:8}}>
            <div style={{fontSize:13,fontWeight:700}}>Dívidas Ativas</div>
            <button onClick={function(){setModal({type:"div",title:"Nova Dívida",data:{}})}} style={{background:"none",border:"none",cursor:"pointer",color:T.green,fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:3}}><Plus size={12} />Nova</button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10}}>
            {(db.dividas||[]).map(function(d) {
              var rest = Math.max(0,d.total-d.pago);
              var pr = d.total>0 ? (d.pago/d.total)*100 : 0;
              var mesesRest = d.parcela > 0 ? Math.ceil(rest / d.parcela) : 0;
              var quitRef = addMesRef(mes, ano, mesesRest);
              return <div key={d.id} style={bx}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                  <div><div style={{fontSize:12,fontWeight:700}}>{d.nome}</div><div style={{fontSize:11,color:T.dim}}>{d.pRest} parc. - {d.taxa}% a.m.</div></div>
                  <div style={{display:"flex",gap:3}}><span style={{fontSize:14,fontWeight:700,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",color:T.gold}}>{f$(d.parcela)}/m</span><IBtn icon={Edit3} onClick={function(){setModal({type:"div",title:"Editar",data:d})}} /><IBtn icon={Trash2} color={T.red} onClick={function(){del("dividas",d.id)}} /></div>
                </div>
                <PB value={d.pago} max={d.total} color={T.cyan} />
                <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:12}}><span style={{color:T.green}}>Pago: {f$(d.pago)}</span><span style={{color:T.red}}>Rest: {f$(rest)}</span><span style={{color:T.cyan}}>{pct(pr)}</span></div>
                {mesesRest > 0 && <div style={{marginTop:8,padding:"7px 10px",borderRadius:8,background:T.cyan+"08",border:"1px solid "+T.cyan+"12",fontSize:12,color:T.muted,display:"flex",justifyContent:"space-between"}}>
                  <span>Quitacao estimada: <strong style={{color:T.cyan}}>{MSF[quitRef.mes-1]}/{quitRef.ano}</strong></span>
                  <span style={{color:T.dim}}>{mesesRest} mes(es)</span>
                </div>}
                {rest <= 0 && <div style={{marginTop:8,padding:"7px 10px",borderRadius:8,background:T.green+"12",border:"1px solid "+T.green+"20",fontSize:12,color:T.green,fontWeight:700,textAlign:"center"}}>Dívida quitada!</div>}
              </div>;
            })}
          </div>
        </div>}

        {}
        {tab==="metas" && (function(){
          var totalInvAtual = (db.investimentos||[]).reduce(function(s,i){return s+i.valor},0);
          var aporteFixo = db.investimentoFixo || 5000;
          var rendMensal = (db.investimentos||[]).reduce(function(s,i){return s+(i.valor*(i.rent||0)/100)},0);
          var totalMetas = metP.length;
          var metasAtingidas = metP.filter(function(m){return m.pr>=100}).length;
          var metaFinal = metP.length > 0 ? Math.max.apply(null,metP.map(function(m){return m.valor})) : 0;
          var progressoGeral = metaFinal > 0 ? Math.min(100,Math.round(totalInvAtual/metaFinal*100)) : 0;
          var proximaMeta = metP.filter(function(m){return m.pr<100}).sort(function(a,b){return a.valor-b.valor})[0];

          return <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <div style={{display:"flex",alignItems:"center",gap:7}}><Target size={14} color={T.green} /><h2 style={{margin:0,fontSize:15,fontWeight:700}}>Metas de Investimento</h2></div>
              <div style={{display:"flex",gap:6}}>
                <button onClick={function(){setShowAporteModal(true)}} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:7,background:T.gold+"15",border:"1px solid "+T.gold+"25",color:T.gold,cursor:"pointer",fontSize:12,fontWeight:700}}><Zap size={11} /> Aportar</button>
                <button onClick={function(){setModal({type:"meta",title:"Nova Meta",data:{vinc:"invest"}})}} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:7,background:T.green,border:"none",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:600}}><Plus size={12} /> Nova</button>
              </div>
            </div>
            <div style={{padding:"10px 16px",borderRadius:10,background:"linear-gradient(135deg,"+T.card+","+T.green+"06)",border:"1px solid "+T.green+"15",marginBottom:12,textAlign:"center"}}><span style={{fontSize:12,fontStyle:"italic",color:T.greenL}}>"{frase}"</span></div>

            {/* KPI Summary */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:18,background:"linear-gradient(135deg, "+T.card+", "+T.green+"06)",borderColor:T.green+"20"})}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:14,padding:"12px 14px",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.5,fontWeight:600}}>PATRIMÔNIO ATUAL</div>
                  <div style={{fontSize:22,fontWeight:900,color:T.cyan,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",marginTop:4}}>{f$(totalInvAtual)}</div>
                  <div style={{fontSize:11,color:T.dim,marginTop:2}}>{metasAtingidas}/{totalMetas} metas atingidas</div>
                </div>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:14,padding:"12px 14px",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.5,fontWeight:600}}>PRÓXIMA META</div>
                  <div style={{fontSize:22,fontWeight:900,color:T.gold,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",marginTop:4}}>{proximaMeta ? f$(proximaMeta.valor) : "Todas atingidas!"}</div>
                  <div style={{fontSize:11,color:T.dim,marginTop:2}}>{proximaMeta ? "Faltam "+f$(proximaMeta.ft) : ""}</div>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>APORTE MENSAL</div>
                  <div style={{fontSize:13,fontWeight:800,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(aporteFixo)}</div>
                </div>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>RENDIMENTO</div>
                  <div style={{fontSize:13,fontWeight:800,color:T.purple,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>+{f$(rendMensal)}/m</div>
                </div>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>CRESCIMENTO</div>
                  <div style={{fontSize:13,fontWeight:800,color:T.cyan,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(aporteFixo+rendMensal)}/m</div>
                </div>
              </div>
            </div>

            {/* Timeline visual */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:12}}>Timeline das metas</div>
              <div style={{position:"relative",paddingLeft:20}}>
                <div style={{position:"absolute",left:6,top:0,bottom:0,width:2,background:"rgba(255,255,255,0.04)",borderRadius:1}} />
                {metP.sort(function(a,b){return a.valor-b.valor}).map(function(m,i){
                  var atingido = m.pr >= 100;
                  var emRisco = m.dr < 30 && m.pr < 80;
                  var status = atingido ? "ATINGIDA" : emRisco ? "EM RISCO" : m.pr >= 70 ? "QUASE" : "EM PROGRESSO";
                  var statusCor = atingido ? T.green : emRisco ? T.red : m.pr >= 70 ? T.gold : T.cyan;
                  var mesesParaAtingir = m.ft > 0 && (aporteFixo + rendMensal) > 0 ? Math.ceil(m.ft / (aporteFixo + rendMensal)) : 0;
                  var mesEstimado = mesesParaAtingir > 0 ? MSF[Math.min(11,(new Date().getMonth() + mesesParaAtingir)%12)] + "/" + (2026 + Math.floor((new Date().getMonth() + mesesParaAtingir)/12)) : "";
                  return <div key={m.id} style={{position:"relative",paddingBottom:i<metP.length-1?16:0,paddingLeft:20}}>
                    <div style={{position:"absolute",left:-14,top:4,width:14,height:14,borderRadius:"50%",background:atingido?T.green:statusCor+"20",border:"2px solid "+statusCor,display:"flex",alignItems:"center",justifyContent:"center",zIndex:1}}>
                      {atingido && <Check size={8} color="#020208" />}
                    </div>
                    <div style={{padding:"12px 14px",borderRadius:12,background:"linear-gradient(135deg, "+statusCor+"06, rgba(0,0,0,0.1))",border:"1px solid "+statusCor+"15"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,gap:8}}>
                        <span style={{fontSize:13,fontWeight:600,color:atingido?T.green:T.text,flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.nome}</span>
                        <Sparkline values={(function(){var pts=[];var base=Math.max(0,m.at-m.ft*0.3);for(var k=0;k<8;k++){pts.push(base+(m.at-base)*(k/7)+(Math.sin(k*1.3)*m.valor*0.02))}return pts})()} color={statusCor} w={56} h={18} />
                        <span style={{fontSize:11,fontWeight:500,color:statusCor,background:statusCor+"15",padding:"3px 8px",borderRadius:6,whiteSpace:"nowrap",fontFamily:"'Geist Mono',monospace",letterSpacing:"0.05em"}}>{status}</span>
                      </div>
                      <PB value={m.at} max={m.valor} color={statusCor} h={6} />
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4,marginTop:8}}>
                        <div><div style={{fontSize:10,color:T.dim}}>ATUAL</div><div style={{fontSize:12,fontWeight:700,color:T.cyan,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(m.at)}</div></div>
                        <div style={{textAlign:"center"}}><div style={{fontSize:10,color:T.dim}}>META</div><div style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(m.valor)}</div></div>
                        <div style={{textAlign:"right"}}><div style={{fontSize:10,color:T.dim}}>FALTAM</div><div style={{fontSize:12,fontWeight:700,color:statusCor,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{atingido?"R$ 0":f$(m.ft)}</div></div>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",marginTop:6,paddingTop:6,borderTop:"1px solid rgba(255,255,255,0.03)"}}>
                        <div style={{fontSize:11,color:T.dim}}>Prazo: <strong style={{color:T.muted}}>{fD(m.prazo)}</strong> ({m.dr} dias)</div>
                        {!atingido && mesesParaAtingir > 0 && <div style={{fontSize:11,color:T.dim}}>Estimativa: <strong style={{color:statusCor}}>{mesEstimado}</strong></div>}
                        {atingido && <div style={{fontSize:11,color:T.green,fontWeight:700}}>Meta concluída ✓</div>}
                      </div>
                      {!atingido && <div style={{marginTop:6,display:"flex",gap:6}}>
                        <div style={{flex:1,padding:"5px 8px",borderRadius:6,background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.04)"}}>
                          <div style={{fontSize:10,color:T.dim}}>APORTE NECESSÁRIO</div>
                          <div style={{fontSize:11,fontWeight:700,color:m.aporte > aporteFixo ? T.red : T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(m.aporte)}/mês</div>
                        </div>
                        <div style={{flex:1,padding:"5px 8px",borderRadius:6,background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.04)"}}>
                          <div style={{fontSize:10,color:T.dim}}>SEU APORTE ATUAL</div>
                          <div style={{fontSize:11,fontWeight:700,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(aporteFixo)}/mês</div>
                        </div>
                        <div style={{flex:1,padding:"5px 8px",borderRadius:6,background:m.aporte > aporteFixo ? "rgba(239,68,68,0.04)" : "rgba(0,255,136,0.04)",border:"1px solid "+(m.aporte > aporteFixo ? T.red : T.green)+"10"}}>
                          <div style={{fontSize:10,color:T.dim}}>STATUS</div>
                          <div style={{fontSize:11,fontWeight:700,color:m.aporte > aporteFixo ? T.red : T.green}}>{m.aporte > aporteFixo ? "Insuficiente" : "OK ✓"}</div>
                        </div>
                      </div>}
                    </div>
                  </div>;
                })}
              </div>
            </div>

            {/* Projeção: quando atinge cada meta */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Projeção de atingimento</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:10}}>Com aporte de {f$(aporteFixo)}/mês + rendimento de {f$(rendMensal)}/mês = {f$(aporteFixo+rendMensal)}/mês de crescimento</div>
              {(function(){
                var projData = [];
                var acum = totalInvAtual;
                for (let pm2 = 0; pm2 <= 18; pm2++) {
                  var mIdx = (new Date().getMonth() + pm2) % 12;
                  projData.push({mes:pm2===0?"Hoje":MSF[mIdx].slice(0,3),valor:Math.round(acum)});
                  acum = acum * (1 + (rendMensal > 0 && totalInvAtual > 0 ? rendMensal/totalInvAtual : 0.0087)) + aporteFixo;
                }
                return <div>
                  <ResponsiveContainer width="100%" height={160}>
                    <AreaChart data={projData}><CartesianGrid strokeDasharray="2 6" stroke={T.cyan+"15"} vertical={false} /><XAxis dataKey="mes" tick={{fill:T.cyan+"80",fontSize:10,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"15"}} tickLine={false} /><YAxis tick={{fill:T.cyan+"80",fontSize:10,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"15"}} tickLine={false} tickFormatter={function(v){return (v/1000).toFixed(0)+"k"}} /><Tooltip content={<CustomTooltip />} /><Area type="monotone" dataKey="valor" name="Patrimônio" stroke={T.cyan} fill={T.cyan+"22"} strokeWidth={2} style={{filter:"drop-shadow(0 0 8px "+T.cyan+"70)"}} /></AreaChart>
                  </ResponsiveContainer>
                  <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:8}}>
                    {metP.filter(function(m){return m.pr<100}).sort(function(a,b){return a.valor-b.valor}).map(function(m,i){
                      var mesesP = m.ft > 0 && (aporteFixo + rendMensal) > 0 ? Math.ceil(m.ft / (aporteFixo + rendMensal)) : 0;
                      var mesLabel = mesesP > 0 ? MSF[Math.min(11,(new Date().getMonth()+mesesP)%12)].slice(0,3)+"/"+String(2026+Math.floor((new Date().getMonth()+mesesP)/12)).slice(2) : "?";
                      return <div key={i} style={{padding:"4px 8px",borderRadius:6,background:T.gold+"08",border:"1px solid "+T.gold+"12",fontSize:11}}>
                        <span style={{color:T.gold,fontWeight:700}}>{m.nome}</span>
                        <span style={{color:T.dim,marginLeft:4}}>→ {mesLabel} (~{mesesP}m)</span>
                      </div>;
                    })}
                  </div>
                </div>;
              })()}
            </div>

            {/* Progresso geral */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Progresso geral → R$ {(metaFinal/1000).toFixed(0)}k</div>
              <div style={{position:"relative",height:10,borderRadius:8,background:"rgba(255,255,255,0.04)",overflow:"hidden",marginBottom:6}}>
                <div style={{height:"100%",borderRadius:8,background:"linear-gradient(90deg, "+T.cyan+", "+T.green+")",width:progressoGeral+"%",transition:"width 0.5s"}} />
                {metP.map(function(m,i){var pos=Math.round(m.valor/metaFinal*100);return pos<100?<div key={i} style={{position:"absolute",top:0,left:pos+"%",width:2,height:"100%",background:T.gold,opacity:0.5}} />:null;})}
              </div>
              <div style={{display:"flex",justifyContent:"space-between",position:"relative"}}>
                <span style={{fontSize:11,color:T.cyan,fontWeight:700}}>{f$(totalInvAtual)}</span>
                {metP.map(function(m,i){var pos=Math.round(m.valor/metaFinal*100);return <span key={i} style={{position:"absolute",left:pos+"%",transform:"translateX(-50%)",fontSize:10,color:totalInvAtual>=m.valor?T.green:T.dim,fontWeight:600}}>{(m.valor/1000).toFixed(0)}k</span>;})}
                <span style={{fontSize:11,color:T.dim}}>{f$(metaFinal)}</span>
              </div>
            </div>

            {/* Simulador rápido */}
            <div style={Object.assign({},bx,{padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10,color:T.purple}}>💡 O que acontece se você aumentar o aporte?</div>
              {[
                {extra:0,label:"Atual ("+f$(aporteFixo)+"/m)"},
                {extra:1000,label:"+R$ 1.000 ("+f$(aporteFixo+1000)+"/m)"},
                {extra:2000,label:"+R$ 2.000 ("+f$(aporteFixo+2000)+"/m)"},
                {extra:3000,label:"+R$ 3.000 ("+f$(aporteFixo+3000)+"/m)"}
              ].map(function(sim,i){
                var crescMensal = aporteFixo + sim.extra + rendMensal;
                var mesesPara100k = metaFinal > totalInvAtual && crescMensal > 0 ? Math.ceil((metaFinal - totalInvAtual) / crescMensal) : 0;
                var mesLabel = mesesPara100k > 0 ? MSF[Math.min(11,(new Date().getMonth()+mesesPara100k)%12)]+"/"+String(2026+Math.floor((new Date().getMonth()+mesesPara100k)/12)) : "Já atingido";
                return <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 0",borderBottom:i<3?"1px solid rgba(255,255,255,0.03)":"none"}}>
                  <div style={{width:4,height:24,borderRadius:2,background:i===0?T.cyan:T.purple,flexShrink:0,opacity:1-i*0.2}} />
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,fontWeight:600,color:i===0?T.cyan:T.text}}>{sim.label}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:12,fontWeight:700,color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{mesesPara100k}m</div>
                    <div style={{fontSize:11,color:T.dim}}>{mesLabel}</div>
                  </div>
                </div>;
              })}
            </div>
          </div>;
        })()}

        {}
        {tab==="invest" && (function(){
          var invs = db.investimentos || [];
          var totalInv = invs.reduce(function(s,i){return s+i.valor},0);
          var rendMensal = invs.reduce(function(s,i){return s+(i.valor*(i.rent||0)/100)},0);
          var rendAnual = rendMensal * 12;
          var cdiMensal = 0.87;
          var rendCdi = totalInv * cdiMensal / 100;
          var vsCdi = rendCdi > 0 ? Math.round(rendMensal / rendCdi * 100) : 0;
          var aporteFixo = db.investimentoFixo || 5000;
          var divAtivas = (db.dividas || []).filter(function(d){return !d.quitada});
          var totalDiv = divAtivas.reduce(function(s,d){return s + Math.max(0,(d.total||0)-(d.pago||0))},0);
          var patLiq = totalInv - totalDiv;
          var despMes = pv.despLancadas || 1;
          var mesesReserva = despMes > 0 ? totalInv / despMes : 0;

          // Agrupar por tipo
          var porTipo = {};
          invs.forEach(function(i){var t=i.tipo||"outro";if(!porTipo[t])porTipo[t]={tipo:t,total:0,items:[]};porTipo[t].total+=i.valor;porTipo[t].items.push(i);});
          var tipoLabels = {cdb:"CDB",lci:"LCI",lca:"LCA",tesouro:"Tesouro",rf:"Renda Fixa",rv:"Renda Variável",fundo:"Fundo",poupanca:"Poupança",previdencia:"Previdência",outro:"Outro"};
          var tipoCores = {cdb:T.cyan,lci:T.green,lca:T.emerald||T.green,tesouro:T.gold,rf:T.blue,rv:T.red,fundo:T.purple,poupanca:T.orange,previdencia:T.orange||T.purple,outro:T.dim};
          var tipoData = Object.keys(porTipo).map(function(k){return{name:tipoLabels[k]||k,value:porTipo[k].total,fill:tipoCores[k]||T.blue}});

          // Agrupar por banco
          var porBanco = {};
          invs.forEach(function(i){var b=i.banco||"outro";if(!porBanco[b])porBanco[b]={banco:b,total:0,items:[]};porBanco[b].total+=i.valor;porBanco[b].items.push(i);});
          var bancoLabels = {santander:"Santander",itau:"Itaú",bradesco:"Bradesco",xp:"XP",nubank:"Nubank",btg:"BTG",inter:"Inter",outro:"Outro"};
          var bancoCores = {santander:"#E11931",itau:"#FF7A00",bradesco:"#CC092F",xp:"#00C853",nubank:"#8A05BE",btg:"#0055A4",inter:"#FF6A00",outro:T.dim};
          var bancoData = Object.keys(porBanco).map(function(k){return{name:bancoLabels[k]||k,value:porBanco[k].total,fill:bancoCores[k]||T.blue}});
          var santanderTotal = porBanco.santander ? porBanco.santander.total : 0;
          var pctSantander = totalInv > 0 ? Math.round(santanderTotal / totalInv * 100) : 0;

          // Liquidez breakdown
          var liqMap = {diaria:0,"90d":0,"180d":0,"360d":0,vencimento:0};
          invs.forEach(function(i){var l=i.liquidez||"diaria";liqMap[l]=(liqMap[l]||0)+i.valor;});
          var liqLabels = {diaria:"Liquidez diária","90d":"90 dias","180d":"180 dias","360d":"360 dias",vencimento:"No vencimento"};
          var liqCores = {diaria:T.cyan,"90d":T.green,"180d":T.gold,"360d":T.orange,vencimento:T.red};

          // Projeção 12 meses
          var proj = [];
          var acum = totalInv;
          for (let pm = 0; pm <= 12; pm++) {
            proj.push({mes:pm===0?"Hoje":["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"][(new Date().getMonth()+pm)%12],valor:Math.round(acum)});
            acum = acum * (1 + (rendMensal > 0 ? rendMensal/totalInv : cdiMensal/100)) + aporteFixo;
          }

          // Metas
          var metaFinal = 100000;
          var marcos = [{v:35000,l:"R$ 35k"},{v:52000,l:"R$ 52k"},{v:100000,l:"R$ 100k"}];

          return <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:7}}><TrendingUp size={14} color={T.blue} /><h2 style={{margin:0,fontSize:15,fontWeight:700}}>Investimentos</h2></div>
              <button onClick={function(){setModal({type:"inv",title:"Novo",data:{tipo:"cdb",banco:"santander",liquidez:"diaria"}})}} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:7,background:T.green,border:"none",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:600}}><Plus size={12} /> Novo</button>
            </div>

            {/* Hero KPIs */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:18,background:"linear-gradient(135deg, "+T.card+", "+T.blue+"06)",borderColor:T.blue+"20"})}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:14,padding:"12px 14px",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.5,fontWeight:600}}>TOTAL INVESTIDO</div>
                  <div style={{fontSize:22,fontWeight:900,color:T.cyan,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",marginTop:4}}>{f$(totalInv)}</div>
                  <div style={{fontSize:11,color:T.dim,marginTop:2}}>{invs.length} ativo{invs.length!==1?"s":""}</div>
                </div>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:14,padding:"12px 14px",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.5,fontWeight:600}}>RENDIMENTO MENSAL</div>
                  <div style={{fontSize:22,fontWeight:900,color:rendMensal>=0?T.green:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums",marginTop:4}}>{rendMensal>=0?"+":""}{f$(rendMensal)}</div>
                  <div style={{fontSize:11,color:T.dim,marginTop:2}}>{rendAnual>=0?"+":""}{f$(rendAnual)}/ano</div>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>PATRIMÔNIO LÍQ.</div>
                  <div style={{fontSize:13,fontWeight:800,color:patLiq>=0?T.green:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(patLiq)}</div>
                </div>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>VS CDI ({cdiMensal}%/M)</div>
                  <div style={{fontSize:13,fontWeight:800,color:vsCdi>=100?T.green:T.gold,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{vsCdi}%</div>
                </div>
                <div style={{background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"8px 10px",textAlign:"center",border:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{fontSize:11,color:T.dim,letterSpacing:0.4}}>RESERVA</div>
                  <div style={{fontSize:13,fontWeight:800,color:mesesReserva>=6?T.green:mesesReserva>=3?T.gold:T.red,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{mesesReserva.toFixed(1)} meses</div>
                </div>
              </div>
            </div>

            {/* Meta R$ 100k */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Meta: R$ 100.000</div>
              <PB value={totalInv} max={metaFinal} color={T.cyan} h={8} />
              <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:11,color:T.dim}}>
                <span>{f$(totalInv)}</span>
                <span>{Math.round(totalInv/metaFinal*100)}%</span>
                <span>{f$(metaFinal)}</span>
              </div>
              <div style={{display:"flex",gap:4,marginTop:8}}>
                {marcos.map(function(m,i){var atingido=totalInv>=m.v;return <div key={i} style={{flex:1,padding:"6px 8px",borderRadius:8,background:atingido?"rgba(0,255,136,0.06)":"rgba(255,255,255,0.02)",border:"1px solid "+(atingido?T.green+"15":"rgba(255,255,255,0.04)"),textAlign:"center"}}>
                  <div style={{fontSize:11,fontWeight:700,color:atingido?T.green:T.dim}}>{m.l}</div>
                  <div style={{fontSize:10,color:atingido?T.green:T.dim,marginTop:2}}>{atingido?"Atingido ✓":"Pendente"}</div>
                </div>;})}
              </div>
              {totalInv < metaFinal && aporteFixo > 0 && <div style={{marginTop:8,padding:"8px 10px",borderRadius:8,background:"rgba(0,229,255,0.04)",border:"1px solid rgba(0,229,255,0.08)",fontSize:11,color:T.cyan}}>
                Com aporte de {f$(aporteFixo)}/mês + rendimento, atingirá R$ 100k em ~{Math.ceil((metaFinal - totalInv) / (aporteFixo + rendMensal))} meses ({MSF[Math.min(11,(new Date().getMonth() + Math.ceil((metaFinal - totalInv) / (aporteFixo + rendMensal)))%12)]}/{2026 + Math.floor((new Date().getMonth() + Math.ceil((metaFinal - totalInv) / (aporteFixo + rendMensal)))/12)}).
              </div>}
            </div>

            {/* Concentração Santander */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16,background:"linear-gradient(135deg, "+T.card+", #E1193106)",borderColor:"#E1193120"})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:8,color:"#E11931"}}>🏦 Concentração Santander</div>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{position:"relative",width:60,height:60}}>
                  <svg viewBox="0 0 36 36" style={{width:60,height:60,transform:"rotate(-90deg)"}}><circle cx="18" cy="18" r="14" fill="none" stroke={T.border} strokeWidth="3" /><circle cx="18" cy="18" r="14" fill="none" stroke="#E11931" strokeWidth="3" strokeDasharray={String(pctSantander*0.88)+" 88"} strokeLinecap="round" /></svg>
                  <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:900,color:"#E11931",fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{pctSantander}%</div>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,color:T.muted}}>No Santander: <strong style={{color:"#E11931",fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(santanderTotal)}</strong></div>
                  <div style={{fontSize:12,color:T.dim,marginTop:2}}>Fora: <strong style={{fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(totalInv - santanderTotal)}</strong></div>
                  <div style={{marginTop:6,fontSize:11,padding:"4px 8px",borderRadius:6,background:pctSantander>=80?"rgba(0,255,136,0.06)":"rgba(255,208,0,0.06)",color:pctSantander>=80?T.green:T.gold,border:"1px solid "+(pctSantander>=80?T.green:T.gold)+"15"}}>{pctSantander>=80?"Concentração ideal para upgrade ✓":"Ideal: 80%+ no Santander para maximizar rating"}</div>
                </div>
              </div>
            </div>

            {/* Distribuição por tipo + por banco */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <div style={bx}>
                <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Por tipo</div>
                {tipoData.length > 0 ? <div>
                  <ResponsiveContainer width="100%" height={100}><PieChart><Pie data={tipoData} dataKey="value" cx="50%" cy="50%" outerRadius={40} innerRadius={20} paddingAngle={2} strokeWidth={0} style={{filter:"drop-shadow(0 0 6px "+T.cyan+"40)"}}>{tipoData.map(function(e,idx){return <Cell key={idx} fill={e.fill} stroke={e.fill+"80"} strokeWidth={0.5} style={{filter:"drop-shadow(0 0 3px "+e.fill+"50)"}} />})}</Pie><Tooltip contentStyle={{background:"rgba(8,8,20,0.95)",border:"1px solid "+T.cyan+"25",borderRadius:12,fontSize:12,boxShadow:"0 0 30px "+T.cyan+"15, 0 12px 32px rgba(0,0,0,0.5)",backdropFilter:"blur(20px)"}} itemStyle={{color:T.text}} labelStyle={{color:T.cyan,fontWeight:700,letterSpacing:1}} formatter={function(v){return [f$(v),"Valor"]}} /></PieChart></ResponsiveContainer>
                  {tipoData.map(function(t,i){return <div key={i} style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}><div style={{width:6,height:6,borderRadius:3,background:t.fill}} /><span style={{fontSize:11,color:T.muted,flex:1}}>{t.name}</span><span style={{fontSize:11,fontWeight:700,color:T.text,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{totalInv>0?Math.round(t.value/totalInv*100):"0"}%</span></div>;})}
                </div> : <div style={{fontSize:11,color:T.dim,textAlign:"center",padding:20}}>Sem dados</div>}
              </div>
              <div style={bx}>
                <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Por banco</div>
                {bancoData.length > 0 ? <div>
                  <ResponsiveContainer width="100%" height={100}><PieChart><Pie data={bancoData} dataKey="value" cx="50%" cy="50%" outerRadius={40} innerRadius={20} paddingAngle={2} strokeWidth={0} style={{filter:"drop-shadow(0 0 6px "+T.cyan+"40)"}}>{bancoData.map(function(e,idx){return <Cell key={idx} fill={e.fill} stroke={e.fill+"80"} strokeWidth={0.5} style={{filter:"drop-shadow(0 0 3px "+e.fill+"50)"}} />})}</Pie><Tooltip contentStyle={{background:"rgba(8,8,20,0.95)",border:"1px solid "+T.cyan+"25",borderRadius:12,fontSize:12,boxShadow:"0 0 30px "+T.cyan+"15, 0 12px 32px rgba(0,0,0,0.5)",backdropFilter:"blur(20px)"}} itemStyle={{color:T.text}} labelStyle={{color:T.cyan,fontWeight:700,letterSpacing:1}} formatter={function(v){return [f$(v),"Valor"]}} /></PieChart></ResponsiveContainer>
                  {bancoData.map(function(b,i){return <div key={i} style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}><div style={{width:6,height:6,borderRadius:3,background:b.fill}} /><span style={{fontSize:11,color:T.muted,flex:1}}>{b.name}</span><span style={{fontSize:11,fontWeight:700,color:T.text,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{totalInv>0?Math.round(b.value/totalInv*100):"0"}%</span></div>;})}
                </div> : <div style={{fontSize:11,color:T.dim,textAlign:"center",padding:20}}>Sem dados</div>}
              </div>
            </div>

            {/* Liquidez */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Liquidez</div>
              <div style={{height:10,borderRadius:8,background:"rgba(255,255,255,0.04)",overflow:"hidden",display:"flex",marginBottom:8}}>
                {Object.keys(liqMap).filter(function(k){return liqMap[k]>0}).map(function(k,i){return <div key={i} style={{width:(liqMap[k]/Math.max(totalInv,1)*100)+"%",height:"100%",background:liqCores[k]}} />;})}
              </div>
              {Object.keys(liqMap).filter(function(k){return liqMap[k]>0}).map(function(k,i){return <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                <div style={{width:8,height:8,borderRadius:4,background:liqCores[k],flexShrink:0}} />
                <span style={{fontSize:11,color:T.muted,flex:1}}>{liqLabels[k]}</span>
                <span style={{fontSize:11,fontWeight:700,color:T.text,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(liqMap[k])}</span>
                <span style={{fontSize:11,color:T.dim}}>{totalInv>0?Math.round(liqMap[k]/totalInv*100):"0"}%</span>
              </div>;})}
              {liqMap.diaria < despMes * 3 && <div style={{marginTop:8,padding:"6px 10px",borderRadius:8,background:T.gold+"06",border:"1px solid "+T.gold+"10",fontSize:11,color:T.gold}}>⚠ Liquidez diária ({f$(liqMap.diaria)}) cobre apenas {(liqMap.diaria/despMes).toFixed(1)} meses de despesas. Ideal: 3+ meses.</div>}
            </div>

            {/* Projeção 12 meses */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Projeção 12 meses</div>
              <div style={{fontSize:11,color:T.dim,marginBottom:8}}>Aporte: {f$(aporteFixo)}/mês + rendimento {rendMensal>0?pct(rendMensal/totalInv*100):pct(cdiMensal)}/mês</div>
              <ResponsiveContainer width="100%" height={140}>
                <AreaChart data={proj}><CartesianGrid strokeDasharray="2 6" stroke={T.cyan+"15"} vertical={false} /><XAxis dataKey="mes" tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"15"}} tickLine={false} /><YAxis tick={{fill:T.cyan+"80",fontSize:11,fontFamily:"Geist Mono,monospace"}} axisLine={{stroke:T.cyan+"15"}} tickLine={false} tickFormatter={function(v){return "R$"+(v/1000).toFixed(0)+"k"}} /><Tooltip content={<CustomTooltip />} /><Area type="monotone" dataKey="valor" name="Patrimônio" stroke={T.cyan} fill={T.cyan+"22"} strokeWidth={2} style={{filter:"drop-shadow(0 0 8px "+T.cyan+"70)"}} /></AreaChart>
              </ResponsiveContainer>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
                <div style={{fontSize:11,color:T.dim}}>Hoje: <strong style={{color:T.cyan,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(totalInv)}</strong></div>
                <div style={{fontSize:11,color:T.dim}}>Em 12m: <strong style={{color:T.green,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{f$(proj[proj.length-1].valor)}</strong></div>
              </div>
            </div>

            {/* Alocação ideal */}
            <div style={Object.assign({},bx,{marginBottom:12,padding:16})}>
              <div style={{fontSize:12,fontWeight:800,marginBottom:10,color:T.gold}}>💡 Alocação ideal para rating</div>
              {[
                {nome:"CDB Liquidez Diária",pct:"40%",desc:"Almofada + emergência. Rendimento ~100% CDI. Resgate imediato.",cor:T.cyan,valor:Math.round(aporteFixo*0.4)},
                {nome:"LCI / LCA (prazo)",pct:"50%",desc:"Maior rendimento. Isento de IR. Prazo mínimo 90 dias.",cor:T.green,valor:Math.round(aporteFixo*0.5)},
                {nome:"Previdência PGBL",pct:"10%",desc:"+1 produto de relacionamento. Deduz até 12% do IR.",cor:T.purple,valor:Math.round(aporteFixo*0.1)}
              ].map(function(a,i){return <div key={i} style={{display:"flex",gap:10,padding:"8px 0",borderBottom:i<2?"1px solid rgba(255,255,255,0.03)":"none"}}>
                <div style={{width:4,height:32,borderRadius:2,background:a.cor,flexShrink:0,marginTop:2}} />
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                    <span style={{fontSize:12,fontWeight:700,color:T.text}}>{a.nome}</span>
                    <span style={{fontSize:12,fontWeight:700,color:a.cor,fontFamily:"'Geist Mono','SF Mono','JetBrains Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{a.pct} ({f$(a.valor)}/mês)</span>
                  </div>
                  <div style={{fontSize:11,color:T.dim,marginTop:2}}>{a.desc}</div>
                </div>
              </div>;})}
              <div style={{marginTop:8,padding:"8px 10px",borderRadius:8,background:"rgba(225,25,49,0.04)",border:"1px solid rgba(225,25,49,0.08)",fontSize:11,color:"#E11931"}}>🎯 Tudo no Santander. Cada real investido no banco constrói patrimônio e fortalece o caso para upgrade.</div>
            </div>

            {/* Cards por ativo */}
            <div style={{fontSize:12,fontWeight:800,marginBottom:10}}>Ativos ({invs.length})</div>
            {invs.map(function(x,i) {
              var rend = x.valor*(x.rent||0)/100;
              var corBanco = bancoCores[x.banco||"outro"]||T.blue;
              var rate = (x.rent||0.87)/100;
              var sparkVals = (function(){var pts=[];for(var k=0;k<8;k++){pts.push(x.valor*Math.pow(1+rate,k))}return pts})();
              return <div key={x.id} style={Object.assign({},bx,{marginBottom:10,padding:0,overflow:"hidden"})}>
                <div style={{padding:"12px 16px",background:"linear-gradient(135deg, "+corBanco+"06, transparent)",borderBottom:"1px solid "+corBanco+"10",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
                  <div style={{minWidth:0,flex:1}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontSize:13,fontWeight:600}}>{x.nome}</span>
                      <IBtn icon={Edit3} onClick={function(){setModal({type:"inv",title:"Editar",data:x})}} />
                      <IBtn icon={Trash2} color={T.red} onClick={function(){del("investimentos",x.id)}} />
                    </div>
                    <div style={{display:"flex",gap:4,marginTop:4,flexWrap:"wrap"}}>
                      <span style={{fontSize:11,padding:"2px 6px",borderRadius:5,background:corBanco+"15",color:corBanco,fontWeight:500,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.04em"}}>{bancoLabels[x.banco||"outro"]||x.banco}</span>
                      <span style={{fontSize:11,padding:"2px 6px",borderRadius:5,background:"rgba(255,255,255,0.05)",color:T.muted,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.04em"}}>{tipoLabels[x.tipo||"outro"]||x.tipo}</span>
                      <span style={{fontSize:11,padding:"2px 6px",borderRadius:5,background:"rgba(255,255,255,0.05)",color:T.muted,fontFamily:"'Geist Mono',monospace",letterSpacing:"0.04em"}}>{liqLabels[x.liquidez||"diaria"]||x.liquidez}</span>
                    </div>
                  </div>
                  <Sparkline values={sparkVals} color={x.rent>=0?T.green:T.red} w={64} h={24} />
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:18,fontWeight:600,fontFamily:"'Geist Mono',monospace",color:x.rent>=0?T.green:T.red,letterSpacing:"-0.01em"}}>{x.rent>=0?"+":""}{x.rent}%</div>
                    <div style={{fontSize:12,fontWeight:500,fontFamily:"'Geist Mono',monospace",color:rend>=0?T.green:T.red}}>{rend>=0?"+":""}{f$(rend)}/m</div>
                  </div>
                </div>
                <div style={{padding:"8px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <EV value={x.valor} onChange={function(v){ups("investimentos",Object.assign({},x,{valor:v}))}} />
                  <span style={{fontSize:12,color:T.dim,fontFamily:"'Geist Mono',monospace"}}>{totalInv>0?Math.round(x.valor/totalInv*100):"0"}% do total</span>
                </div>
              </div>;
            })}
          </div>;
        })()}

        {}
        {tab==="alertas" && <div>
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:14}}><div style={{padding:5,borderRadius:8,background:T.red+"12",display:"flex",border:"1px solid "+T.red+"10"}}><Bell size={14} color={T.red} /></div><h2 style={{margin:0,fontSize:16,fontWeight:900,letterSpacing:-0.2}}>Alertas ({als.length})</h2></div>
          <div style={bx}>
            {als.length===0 ? <div style={{textAlign:"center",padding:28,color:T.dim}}><div style={{width:52,height:52,borderRadius:14,background:T.green+"12",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 10px",border:"1px solid "+T.green+"15"}}><Shield size={24} color={T.green} /></div><div style={{fontSize:13,fontWeight:700,color:T.green}}>Tudo em ordem!</div><div style={{fontSize:12,color:T.dim,marginTop:4}}>Nenhum alerta ativo no periodo</div></div> :
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              {als.map(function(a,i) {
                var cor = a.s==="danger" ? T.red : T.gold;
                var icon = a.s==="danger" ? "CRITICO" : "ATENCAO";
                return <div key={i} style={{padding:"12px 14px",borderRadius:14,background:"linear-gradient(135deg, "+cor+"06, rgba(255,255,255,0.02))",border:"1px solid "+cor+"14",boxShadow:"0 4px 12px "+cor+"08, inset 0 1px 0 rgba(255,255,255,0.02)"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}><AlertTriangle size={13} color={cor} /><span style={{fontSize:12,fontWeight:700,flex:1,color:T.text}}>{a.m}</span><Bd color={cor}>{icon}</Bd><Bd color={T.dim}>{a.t}</Bd></div>
                  {a.r && <div style={{fontSize:12,color:cor,marginLeft:22,paddingTop:4,borderTop:"1px solid "+cor+"10",marginTop:4}}>{"→ "+a.r}</div>}
                </div>;
              })}
            </div>}
          </div>
        </div>}

        {/* ===== IA ===== */}
        {tab==="ia" && (function(){if(!iaTabLoaded)setIaTabLoaded(true);return null})()}
        {tab==="ia" && iaTabLoaded && <div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
            <div style={{padding:5,borderRadius:8,background:T.cyan+"12",display:"flex",border:"1px solid "+T.cyan+"10"}}><Activity size={15} color={T.cyan} /></div>
            <h2 style={{margin:0,fontSize:17,fontWeight:900,letterSpacing:-0.3,color:T.cyan,textShadow:"0 0 10px "+T.cyan+"40"}}>Assistente IA</h2>
            {aiLoading && <span style={{fontSize:11,color:T.cyan,animation:"pulse 1.5s infinite",fontWeight:700}}>PROCESSANDO...</span>}
          </div>

          {/* ANALISAR TUDO */}
          <div style={Object.assign({},bx,{marginBottom:14,background:"linear-gradient(135deg,"+T.cyan+"08,"+T.purple+"06)",borderColor:T.cyan+"20",textAlign:"center"})}>
            <button onClick={analyzeAll} disabled={aiLoading} style={{width:"100%",padding:"12px 20px",borderRadius:10,background:aiLoading?"rgba(255,255,255,0.04)":"linear-gradient(135deg,"+T.cyan+","+T.purple+")",border:"none",color:aiLoading?T.dim:"#000",cursor:aiLoading?"wait":"pointer",fontSize:13,fontWeight:900,letterSpacing:0.5,display:"flex",alignItems:"center",justifyContent:"center",gap:8,boxShadow:aiLoading?"none":"0 0 24px "+T.cyan+"30"}}><Activity size={16} />{aiAllProg>0 ? "Análisando... ("+aiAllProg+"/9)" : "Análisar tudo"}</button>
            {aiAllProg > 0 && <div style={{marginTop:10}}>
              <div style={{height:4,borderRadius:2,background:"rgba(255,255,255,0.06)",overflow:"hidden"}}><div style={{height:"100%",borderRadius:2,background:"linear-gradient(90deg,"+T.cyan+","+T.purple+")",width:Math.round(aiAllProg/9*100)+"%",transition:"width 0.5s ease"}} /></div>
              <div style={{fontSize:11,color:T.cyan,marginTop:4}}>{["","Resumo semanal","Insights","Coach rating","Plano metas","Previsão","Anomalias","Economia","Diagnostico","Relatório"][aiAllProg]||""}</div>
            </div>}
            {aiAllProg === 0 && <div style={{fontSize:11,color:T.dim,marginTop:6}}>Gera 9 analises completas com um clique: resumo semanal, insights, coach, plano, previsao, anomalias, economia, diagnostico e relatório.</div>}
          </div>

          {/* ENTRADA POR TEXTO LIVRE */}
          <div style={Object.assign({},bx,{marginBottom:14,borderColor:T.green+"15"})}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}><Plus size={13} color={T.green} /><div style={{fontSize:13,fontWeight:800}}>Lançamento por voz</div></div>
            <div style={{fontSize:12,color:T.dim,marginBottom:8}}>Digite naturalmente: "paguei 150 de luz ontem no pix" ou "parcela 3/9 serasa 96,36 pendente"</div>
            <div style={{display:"flex",gap:6}}>
              <input value={aiNlpInput} onChange={function(e){setAiNlpInput(e.target.value)}} onKeyDown={function(e){if(e.key==="Enter")parseNaturalLanc()}} placeholder="Ex: gastei 50 no uber ontem..." style={Object.assign({},inp,{flex:1,fontSize:12})} />
              <button onClick={parseNaturalLanc} disabled={aiLoading} style={{padding:"8px 14px",borderRadius:10,background:aiLoading?"rgba(255,255,255,0.04)":T.green,border:"none",color:aiLoading?T.dim:"#000",cursor:aiLoading?"wait":"pointer",fontSize:12,fontWeight:800,flexShrink:0}}>Criar</button>
            </div>
          </div>

          {/* RESUMO SEMANAL */}
          <div style={Object.assign({},bx,{marginBottom:14,borderColor:T.cyan+"15",background:"linear-gradient(135deg,"+T.card+","+T.cyan+"04)"})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}><Calendar size={13} color={T.cyan} /><div style={{fontSize:13,fontWeight:800}}>Resumo semanal</div></div>
              <button onClick={generateWeekly} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.cyan+"18",border:"1px solid "+T.cyan+"20",color:aiLoading?T.dim:T.cyan,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:3}}><Activity size={10} />{aiLoading?"Análisando...":"Atualizar"}</button>
            </div>
            {aiWeekly ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiWeekly}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Resumo da semana: gastos, vencimentos proximos, ritmo de gasto vs orçamento.</div>}
          </div>

          {/* GRID: INSIGHTS + COACH */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(280px, 1fr))",gap:12,marginBottom:14}}>
            <div style={Object.assign({},bx,{borderColor:T.cyan+"12"})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}><Activity size={12} color={T.cyan} /><span style={{fontSize:13,fontWeight:800}}>Insights do mes</span></div>
                <button onClick={generateInsights} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.cyan+"18",border:"1px solid "+T.cyan+"20",color:aiLoading?T.dim:T.cyan,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Gerar</button>
              </div>
              {aiInsights ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiInsights}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>IA analisa padroes de gasto e gera observacoes.</div>}
            </div>

            <div style={Object.assign({},bx,{borderColor:T.gold+"12"})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}><Shield size={12} color={T.gold} /><span style={{fontSize:13,fontWeight:800}}>Coach de rating</span></div>
                <button onClick={getRatingCoach} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.gold+"18",border:"1px solid "+T.gold+"20",color:aiLoading?T.dim:T.gold,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Hoje</button>
              </div>
              {aiCoach ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiCoach}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Acoes concretas para hoje baseadas no ciclo do mês.</div>}
            </div>
          </div>

          {/* SIMULADOR E SE */}
          <div style={Object.assign({},bx,{marginBottom:14,borderColor:T.purple+"12"})}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}><Search size={12} color={T.purple} /><div style={{fontSize:13,fontWeight:800}}>Simulador "E se?"</div></div>
            <div style={{display:"flex",gap:6,marginBottom:8}}>
              <input value={aiSimQ} onChange={function(e){setAiSimQ(e.target.value)}} onKeyDown={function(e){if(e.key==="Enter")simulateWhatIf()}} placeholder="Ex: e se eu quitar o Serasa antecipado?" style={Object.assign({},inp,{flex:1,fontSize:12})} />
              <button onClick={simulateWhatIf} disabled={aiLoading} style={{padding:"6px 12px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.purple+"20",border:"1px solid "+T.purple+"25",color:aiLoading?T.dim:T.purple,cursor:aiLoading?"wait":"pointer",fontSize:12,fontWeight:700,flexShrink:0}}>Simular</button>
            </div>
            {aiSim && <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiSim}</div>}
          </div>

          {/* GRID: PLANO + PREVISAO + ECONOMIA + ANOMALIAS */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(280px, 1fr))",gap:12,marginBottom:14}}>
            <div style={Object.assign({},bx,{borderColor:T.green+"12"})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}><Target size={12} color={T.green} /><span style={{fontSize:13,fontWeight:800}}>Plano de metas</span></div>
                <button onClick={generatePlan} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.green+"18",border:"1px solid "+T.green+"20",color:aiLoading?T.dim:T.green,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Gerar</button>
              </div>
              {aiPlan ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiPlan}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Estrategia otimizada para atingir metas.</div>}
            </div>

            <div style={Object.assign({},bx,{borderColor:T.sky+"12"})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}><TrendingUp size={12} color={T.sky} /><span style={{fontSize:13,fontWeight:800}}>Previsão proximo mes</span></div>
                <button onClick={predictNextMonth} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.sky+"18",border:"1px solid "+T.sky+"20",color:aiLoading?T.dim:T.sky,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Prever</button>
              </div>
              {aiPredict ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiPredict}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Projeta receitas, despesas e sobra do mês seguinte.</div>}
            </div>

            <div style={Object.assign({},bx,{borderColor:T.orange+"12"})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}><DollarSign size={12} color={T.orange} /><span style={{fontSize:13,fontWeight:800}}>Dicas de economia</span></div>
                <button onClick={suggestEconomy} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.orange+"18",border:"1px solid "+T.orange+"20",color:aiLoading?T.dim:T.orange,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Análisar</button>
              </div>
              {aiEcon ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiEcon}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Sugere cortes e otimizações com valor estimado.</div>}
            </div>

            <div style={Object.assign({},bx,{borderColor:T.red+"12"})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}><AlertTriangle size={12} color={T.red} /><span style={{fontSize:13,fontWeight:800}}>Detector de anomalias</span></div>
                <button onClick={detectAnomalies} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.red+"18",border:"1px solid "+T.red+"20",color:aiLoading?T.dim:T.red,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Detectar</button>
              </div>
              {aiAnom ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiAnom}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Compara 3 meses e flagra gastos fora do padrao.</div>}
            </div>
          </div>

          {/* DESPESAS RECORRENTES AUTO-DETECTADAS */}
          <div style={Object.assign({},bx,{marginBottom:14,borderColor:T.purple+"12"})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}><Repeat size={12} color={T.purple} /><span style={{fontSize:13,fontWeight:800}}>Despesas recorrentes</span></div>
              <button onClick={detectRecurring} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.purple+"18",border:"1px solid "+T.purple+"20",color:aiLoading?T.dim:T.purple,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Detectar</button>
            </div>
            {aiRecur ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiRecur}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>A IA analisa 3 meses de lancamentos e identifica despesas que se repetem mas nao estao nas fixas. Sugere quais cadastrar como fixa.</div>}
          </div>

          {/* GRID: DIVIDAS + ORCAMENTO + DIAGNOSTICO */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(280px, 1fr))",gap:12,marginBottom:14}}>
            <div style={Object.assign({},bx,{borderColor:T.ruby+"12"})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}><Landmark size={12} color={T.ruby} /><span style={{fontSize:13,fontWeight:800}}>Comparador de dividas</span></div>
                <button onClick={compareDebts} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.ruby+"18",border:"1px solid "+T.ruby+"20",color:aiLoading?T.dim:T.ruby,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Comparar</button>
              </div>
              {aiDebtCmp ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiDebtCmp}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Avalanche vs bola de neve: qual dívida quitar primeiro.</div>}
            </div>

            <div style={Object.assign({},bx,{borderColor:T.amber+"12"})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}><Wallet size={12} color={T.amber} /><span style={{fontSize:13,fontWeight:800}}>Orçamento inteligente</span></div>
                <button onClick={generateBudget} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.amber+"18",border:"1px solid "+T.amber+"20",color:aiLoading?T.dim:T.amber,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Criar</button>
              </div>
              {aiBudget ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiBudget}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Alocacao ideal por categoria baseada na sua renda.</div>}
            </div>

            <div style={Object.assign({},bx,{borderColor:T.emerald+"12"})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}><CheckCircle size={12} color={T.emerald} /><span style={{fontSize:13,fontWeight:800}}>Diagnostico financeiro</span></div>
                <button onClick={generateDiagnosis} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.emerald+"18",border:"1px solid "+T.emerald+"20",color:aiLoading?T.dim:T.emerald,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Diagnosticar</button>
              </div>
              {aiDiag ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiDiag}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Nota 0-100 por pilar: liquidez, endividamento, poupanca, investimentos.</div>}
            </div>
          </div>

          {/* PROJECAO PATRIMONIAL 12 MESES */}
          <div style={Object.assign({},bx,{marginBottom:14,borderColor:T.sky+"15",background:"linear-gradient(135deg,"+T.card+","+T.sky+"04)"})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}><TrendingUp size={13} color={T.sky} /><div style={{fontSize:13,fontWeight:800}}>Projeção patrimonial 12 meses</div></div>
              <button onClick={generatePatrimonial} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.sky+"18",border:"1px solid "+T.sky+"20",color:aiLoading?T.dim:T.sky,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Projetar</button>
            </div>
            {aiPatrim ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiPatrim}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Projeta mês a mês: patrimonio liquido, dividas que encerram, parcelas que terminam, metas atingidas.</div>}
          </div>

          {/* PLANEJADOR DE COMPRA DE CARRO */}
          <div style={Object.assign({},bx,{marginBottom:14,borderColor:T.purple+"15",background:"linear-gradient(135deg,"+T.card+","+T.purple+"04)"})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}><Wallet size={13} color={T.purple} /><div style={{fontSize:13,fontWeight:800}}>Planejador de compra de carro</div></div>
              <button onClick={generateCarPlan} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.purple+"18",border:"1px solid "+T.purple+"20",color:aiLoading?T.dim:T.purple,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:3}}><Activity size={10} />{aiLoading?"Calculando...":"Planejar"}</button>
            </div>
            {aiCar ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiCar}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Análise completa: valor ideal do carro, melhor momento, financiamento vs consórcio vs à vista, parcela ideal, seguro, IPVA, combustível, manutenção, depreciação e impacto total no orçamento.</div>}
          </div>

          {/* PREPARADOR REUNIAO COM GERENTE */}
          <div style={Object.assign({},bx,{marginBottom:14,borderColor:T.gold+"15",background:"linear-gradient(135deg,"+T.card+","+T.gold+"04)"})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}><Landmark size={13} color={T.gold} /><div style={{fontSize:13,fontWeight:800}}>Preparador para reunião com gerente</div></div>
              <button onClick={generateBankMeeting} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.gold+"18",border:"1px solid "+T.gold+"20",color:aiLoading?T.dim:T.gold,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:3}}><Activity size={10} />{aiLoading?"Preparando...":"Gerar script"}</button>
            </div>
            {aiBankMeet ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiBankMeet}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Script completo para reunião com gerente: como abrir a conversa, argumentos de movimentação, pedido de upgrade (Unlimited/The One), contra-argumentos, negociacao de anuidade e plano B.</div>}
          </div>

          {/* RELATORIO MENSAL */}
          <div style={Object.assign({},bx,{marginBottom:14,borderColor:T.blue+"12"})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}><BarChart3 size={12} color={T.blue} /><span style={{fontSize:13,fontWeight:800}}>Relatório mensal completo</span></div>
              <div style={{display:"flex",gap:6}}>
                {aiReport && <button onClick={exportReportPDF} style={{padding:"5px 10px",borderRadius:8,background:T.green+"18",border:"1px solid "+T.green+"20",color:T.green,cursor:"pointer",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",gap:3}}><Download size={10} /> Exportar</button>}
                <button onClick={generateReport} disabled={aiLoading} style={{padding:"5px 10px",borderRadius:8,background:aiLoading?"rgba(255,255,255,0.04)":T.blue+"18",border:"1px solid "+T.blue+"20",color:aiLoading?T.dim:T.blue,cursor:aiLoading?"wait":"pointer",fontSize:11,fontWeight:700}}>Gerar relatório</button>
              </div>
            </div>
            {aiReport ? <div style={{fontSize:12,color:T.muted,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{aiReport}</div> : <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:12}}>Parecer financeiro completo de {MSF[mes-1]} com analise detalhada.</div>}
          </div>

          {/* CHAT CONSULTOR - SHOWCASE STYLE */}
          <div style={Object.assign({},bx,{marginBottom:14,borderColor:"rgba(255,255,255,0.10)",background:"linear-gradient(135deg, rgba(10,14,28,0.72), rgba(14,18,36,0.52))",position:"relative",overflow:"hidden"})}>
            <div style={{position:"absolute",top:0,left:"15%",right:"15%",height:1,background:"linear-gradient(90deg, transparent, "+T.cyan+"88, "+T.purple+"55, "+T.cyan+"88, transparent)",pointerEvents:"none"}} />
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16,paddingBottom:14,borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
              <div style={{width:40,height:40,borderRadius:12,background:"linear-gradient(135deg, "+T.cyan+", "+T.purple+")",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 30px -6px "+T.cyan+", inset 0 1px 0 rgba(255,255,255,0.25)",position:"relative",color:"#04050C",overflow:"hidden"}}>
                <Activity size={18} strokeWidth={2.5} style={{position:"relative",zIndex:2}} />
                
                <div style={{position:"absolute",inset:-4,borderRadius:14,border:"1px solid "+T.cyan+"55",animation:"orb 2.4s ease-in-out infinite",pointerEvents:"none"}} />
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.dim,letterSpacing:"0.22em",textTransform:"uppercase",marginBottom:3}}>AI · consultor</div>
                <div className="serif-title" style={{fontSize:20,fontWeight:400,letterSpacing:"-0.015em",lineHeight:1.1}}>Command Advisor</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px",border:"1px solid "+T.green+"44",borderRadius:10,background:T.green+"0E"}}>
                <span style={{width:6,height:6,borderRadius:"50%",background:T.green,boxShadow:"0 0 10px "+T.green,animation:"pulse 1.6s ease-in-out infinite"}} />
                <span style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.green,letterSpacing:"0.18em",textTransform:"uppercase",fontWeight:500}}>online</span>
              </div>
              {aiChat.length > 0 && <button onClick={function(){setAiChat([])}} style={{padding:"8px",borderRadius:10,background:"transparent",border:"1px solid rgba(255,255,255,0.08)",color:T.muted,cursor:"pointer",display:"flex",transition:"all 0.2s"}}><Trash2 size={12} /></button>}
            </div>
            <div style={{maxHeight:360,overflowY:"auto",marginBottom:14,display:"flex",flexDirection:"column",gap:12,padding:"4px 2px"}}>
              {aiChat.length === 0 && <div style={{textAlign:"center",padding:"32px 16px"}}>
                <div style={{fontFamily:"'Instrument Serif',serif",fontSize:32,marginBottom:10,color:T.cyan,opacity:0.4,fontStyle:"italic"}}>◇</div>
                <div className="serif-title" style={{fontSize:18,color:T.muted,marginBottom:6,fontStyle:"italic"}}>Pergunte qualquer coisa</div>
                <div style={{fontFamily:"'Geist Mono',monospace",fontSize:12,color:T.dim,letterSpacing:"0.08em"}}>A IA tem acesso aos seus dados de {MSF[mes-1]}</div>
              </div>}
              {aiChat.map(function(m,i){
                var isUser = m.role === "user";
                return <div key={i} style={{alignSelf:isUser?"flex-end":"flex-start",maxWidth:"88%",animation:"fadeUp 0.5s cubic-bezier(0.2,0.8,0.2,1)"}}>
                  {!isUser && <div style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.cyan,letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:4,paddingLeft:4,display:"flex",alignItems:"center",gap:6}}><span style={{width:4,height:4,borderRadius:"50%",background:T.cyan,boxShadow:"0 0 6px "+T.cyan}} />advisor</div>}
                  {isUser && <div style={{fontFamily:"'Geist Mono',monospace",fontSize:11,color:T.muted,letterSpacing:"0.2em",textTransform:"uppercase",marginBottom:4,paddingRight:4,textAlign:"right"}}>você</div>}
                  <div style={{padding:"14px 18px",borderRadius:isUser?"18px 18px 6px 18px":"6px 18px 18px 18px",background:isUser?"linear-gradient(135deg, "+T.cyan+"22, "+T.cyan+"0A)":"linear-gradient(135deg, "+T.purple+"15, "+T.cyan+"06)",border:"1px solid "+(isUser?T.cyan+"44":T.purple+"28"),fontSize:13,color:T.text,lineHeight:1.65,whiteSpace:"pre-wrap",backdropFilter:"blur(14px)",boxShadow:isUser?"0 0 24px -8px "+T.cyan+", 0 8px 20px rgba(0,0,0,0.25)":"0 0 24px -8px "+T.purple+", 0 8px 20px rgba(0,0,0,0.25)",fontFamily:"'Space Grotesk',sans-serif"}}>{m.content}</div>
                </div>;
              })}
              {aiLoading && <div style={{alignSelf:"flex-start",padding:"14px 18px",borderRadius:"6px 18px 18px 18px",background:"linear-gradient(135deg, "+T.purple+"15, "+T.cyan+"06)",border:"1px solid "+T.purple+"28",display:"flex",alignItems:"center",gap:8,animation:"fadeUp 0.5s"}}>
                <span style={{width:7,height:7,borderRadius:"50%",background:T.cyan,animation:"pulseSoft 0.9s ease-in-out infinite",boxShadow:"0 0 8px "+T.cyan}} />
                <span style={{width:7,height:7,borderRadius:"50%",background:T.cyan,animation:"pulseSoft 0.9s ease-in-out infinite 0.2s",boxShadow:"0 0 8px "+T.cyan}} />
                <span style={{width:7,height:7,borderRadius:"50%",background:T.cyan,animation:"pulseSoft 0.9s ease-in-out infinite 0.4s",boxShadow:"0 0 8px "+T.cyan}} />
                <span style={{fontFamily:"'Geist Mono',monospace",fontSize:12,letterSpacing:"0.18em",marginLeft:6,color:T.muted,textTransform:"uppercase"}}>processando</span>
              </div>}
              <div ref={chatEndRef} />
            </div>
            <div style={{display:"flex",gap:8,position:"relative"}}>
              <div style={{flex:1,position:"relative"}}>
                <Activity size={14} color={T.cyan} style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",opacity:0.7,pointerEvents:"none",filter:"drop-shadow(0 0 4px "+T.cyan+"80)"}} />
                <input value={aiInput} onChange={function(e){setAiInput(e.target.value)}} onKeyDown={function(e){if(e.key==="Enter")sendAiMsg()}} placeholder="Pergunte algo ao advisor..." style={{width:"100%",background:"linear-gradient(135deg, rgba(5,8,18,0.6), rgba(10,14,28,0.4))",border:"1px solid "+T.cyan+"2E",borderRadius:12,padding:"12px 14px 12px 40px",color:T.text,fontSize:13,outline:"none",fontFamily:"'Space Grotesk',sans-serif",boxSizing:"border-box",transition:"all 0.2s"}} />
              </div>
              <button onClick={sendAiMsg} disabled={aiLoading} className={aiLoading?"":"ripple-host"} style={{padding:"10px 18px",borderRadius:12,background:aiLoading?"rgba(255,255,255,0.04)":"linear-gradient(135deg, "+T.cyan+", "+T.purple+")",border:aiLoading?"1px solid rgba(255,255,255,0.08)":"none",color:aiLoading?T.dim:"#04050C",cursor:aiLoading?"wait":"pointer",fontSize:12,fontWeight:500,flexShrink:0,boxShadow:aiLoading?"none":"0 0 24px -6px "+T.cyan+", 0 4px 12px rgba(0,0,0,0.3)",fontFamily:"'Space Grotesk',sans-serif",letterSpacing:"-0.005em",transition:"all 0.25s cubic-bezier(0.2,0.8,0.2,1)"}}>{aiLoading?"...":"Enviar ↗"}</button>
            </div>
          </div>
        </div>}

        </div>
        <div style={{textAlign:"center",paddingTop:16,marginTop:24,borderTop:"1px solid rgba(255,255,255,0.04)",color:T.dim,fontSize:11,letterSpacing:0.3}}>COJUR Vault v{VER} — Streaming · Multi-backup · IA paralela • {db.lancamentos.length} lançamentos + {lancEx.length - db.lancamentos.length} projetados</div>
      </div>

      <div style={{position:"fixed",bottom:"max(16px, env(safe-area-inset-bottom))",left:12,right:12,zIndex:900,display:"flex",justifyContent:"center",pointerEvents:"none"}}>
        <div style={{display:"flex",alignItems:"center",padding:"5px 5px",gap:3,background:"linear-gradient(135deg, rgba(10,14,28,0.30), rgba(14,18,36,0.18))",backdropFilter:"blur(48px) saturate(2)",WebkitBackdropFilter:"blur(48px) saturate(2)",border:"1px solid rgba(0,245,212,0.14)",borderRadius:20,boxShadow:"0 24px 60px -20px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(0,245,212,0.08), inset 0 1px 0 rgba(255,255,255,0.06), inset 0 -1px 0 rgba(0,0,0,0.18)",overflowX:"auto",maxWidth:"100%",WebkitOverflowScrolling:"touch",scrollbarWidth:"none",pointerEvents:"auto",position:"relative"}}>
          <div style={{position:"absolute",top:0,left:"12%",right:"12%",height:1,background:"linear-gradient(90deg, transparent, "+T.cyan+"88, "+T.purple+"66, "+T.cyan+"88, transparent)",pointerEvents:"none",borderRadius:"inherit"}} />
          {TABS.map(function(t) {
            var I = t.ic;
            var isAct = tab === t.id;
            var badge = t.id === "cards" ? faturaAlertCount : 0;
            return <button key={t.id} onClick={function(){setTab(t.id)}} style={{position:"relative",display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"10px 12px",border:"none",cursor:"pointer",background:isAct?"linear-gradient(135deg, rgba(0,245,212,0.16), rgba(123,76,255,0.10))":"transparent",borderRadius:12,minWidth:62,flexShrink:0,transition:"all 0.3s cubic-bezier(0.2,0.8,0.2,1)",boxShadow:isAct?"inset 0 0 0 1px rgba(0,245,212,0.30), 0 0 24px -8px "+T.cyan:"none"}}>
              <div style={{position:"relative",display:"flex",alignItems:"center",justifyContent:"center"}}>
                <I size={18} color={isAct?T.cyan:T.muted} style={{filter:isAct?"drop-shadow(0 0 8px "+T.cyan+"CC)":"none",transition:"all 0.25s"}} />
                {badge > 0 && <div style={{position:"absolute",top:-5,right:-7,minWidth:14,height:14,padding:"0 3px",borderRadius:7,background:"linear-gradient(135deg, "+T.orange+", #FF7A3A)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:"#fff",boxShadow:"0 0 10px "+T.orange+"AA, 0 0 4px "+T.orange,border:"1px solid rgba(255,255,255,0.25)",animation:"pulse 1.6s ease-in-out infinite",fontFamily:"'Geist Mono',monospace"}}>{badge}</div>}
              </div>
              <span style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:11,fontWeight:500,color:isAct?T.text:T.muted,whiteSpace:"nowrap",transition:"all 0.2s",letterSpacing:"-0.005em"}}>{t.lb}</span>
              {isAct && <div style={{position:"absolute",bottom:-2,left:"20%",right:"20%",height:2,borderRadius:2,background:T.cyan,boxShadow:"0 0 10px "+T.cyan}} />}
            </button>;
          })}
        </div>
      </div>

      {/* === v15: Command Palette (⌘K) === */}
      <CommandPalette open={cmdOpen} onClose={function(){setCmdOpen(false)}}
        actions={[].concat(
          TABS.map(function(t){ return {id:"tab-"+t.id, label:"Ir para "+t.lb, cat:"navegação", hint:null, _kind:"tab", _tabId:t.id}; }),
          [
            {id:"cmd-novo", label:"Novo lançamento", cat:"criar", hint:"N", _kind:"modal", _modal:"novoLanc"},
            {id:"cmd-mes-prev", label:"Mês anterior", cat:"navegação", hint:"←", _kind:"mes-prev"},
            {id:"cmd-mes-next", label:"Próximo mês", cat:"navegação", hint:"→", _kind:"mes-next"},
            {id:"cmd-hoje", label:"Ir para mês atual", cat:"navegação", hint:"H", _kind:"hoje"},
            {id:"cmd-tema", label:"Alternar tema (claro/escuro)", cat:"ajustes", hint:null, _kind:"tema"},
            {id:"cmd-priv", label:(privateMode?"Sair":"Ativar")+" modo privado", cat:"ajustes", hint:null, _kind:"priv"},
            {id:"cmd-backup", label:"Exportar backup JSON", cat:"dados", hint:null, _kind:"backup"}
          ]
        )}
        onPick={function(a){
          if (a._kind === "tab") { setTab(a._tabId); return; }
          if (a._kind === "modal") { setModal({tipo:a._modal}); return; }
          if (a._kind === "mes-prev") { var nm=mes-1;var na=ano;if(nm<1){nm=12;na--;}setMes(nm);setAno(na); return; }
          if (a._kind === "mes-next") { var nm2=mes+1;var na2=ano;if(nm2>12){nm2=1;na2++;}setMes(nm2);setAno(na2); return; }
          if (a._kind === "hoje") { var hd=new Date();setMes(hd.getMonth()+1);setAno(hd.getFullYear()); return; }
          if (a._kind === "tema") { setDarkMode(!darkMode); return; }
          if (a._kind === "priv") { setPrivateMode(!privateMode); return; }
          if (a._kind === "backup") { try { var blob=new Blob([JSON.stringify(db,null,2)],{type:"application/json"}); var u=URL.createObjectURL(blob); var a2=document.createElement("a"); a2.href=u; a2.download="cojur-vault-backup-"+hj()+".json"; a2.click(); URL.revokeObjectURL(u); } catch(e){} return; }
        }}
      />

    </div>
  );
}
