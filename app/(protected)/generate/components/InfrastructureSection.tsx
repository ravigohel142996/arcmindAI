import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArchitectureData } from "../utils/types";

interface InfrastructureSectionProps {
  infra: ArchitectureData["infrastructure"];
}

export default function InfrastructureSection({
  infra,
}: InfrastructureSectionProps) {
  const infraEntries = Object.entries(infra || {});

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {infraEntries.length === 0 ? (
        <Card>
          <CardContent className="pt-4 text-sm text-gray-600">
            Infrastructure details are still streaming...
          </CardContent>
        </Card>
      ) : (
        infraEntries.map(([key, value]) => (
          <Card key={key}>
            <CardHeader>
              <CardTitle className="text-lg capitalize">
                {key.replace(/([A-Z])/g, " $1")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600">
                {value ? String(value) : "Not specified yet"}
              </p>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
