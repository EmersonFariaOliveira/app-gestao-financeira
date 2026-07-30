import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Dashboard (6.1) — placeholder do shell do app.
 * Implementação real (patrimônio consolidado, alocação atual vs. alvo,
 * banda de tolerância, atalhos e alerta de pendências) entra na Phase 8
 * (T055), depois que import/vínculos/alvos/aporte existirem.
 */
export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-heading font-semibold tracking-tight">
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Visão de 10 segundos: como a carteira está vs. onde deveria estar.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Em construção</CardTitle>
          <CardDescription>
            Patrimônio consolidado, alocação atual vs. alvo e atalhos para
            &quot;Novo import&quot; / &quot;Calcular aporte&quot; aparecerão
            aqui assim que as demais telas estiverem prontas.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Use a navegação à esquerda para acessar as demais telas do app.
        </CardContent>
      </Card>
    </div>
  );
}
