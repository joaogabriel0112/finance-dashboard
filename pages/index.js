import dynamic from "next/dynamic";

// Carrega o Dashboard so no client (evita problema de SSR com window/localStorage/IntersectionObserver)
const Dashboard = dynamic(() => import("../components/Dashboard"), {
  ssr: false,
  loading: () => <div style={{minHeight:"100vh",background:"#04050C",display:"flex",alignItems:"center",justifyContent:"center",color:"#00F5D4",fontFamily:"system-ui",fontSize:14}}>Carregando COJUR Vault...</div>
});

export default function Home() {
  return <Dashboard />;
}
