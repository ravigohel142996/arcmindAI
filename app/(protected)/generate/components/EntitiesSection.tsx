import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArchitectureData } from "../utils/types";

interface EntitiesSectionProps {
  entities: ArchitectureData["entities"];
}

export default function EntitiesSection({ entities }: EntitiesSectionProps) {
  const safeEntities = Array.isArray(entities) ? entities : [];

  return (
    <div className="space-y-4">
      {safeEntities.length === 0 ? (
        <Card>
          <CardContent className="pt-4 text-sm text-gray-600">
            Entities are still streaming...
          </CardContent>
        </Card>
      ) : (
        safeEntities.map((entity, index) => (
          <Card key={index}>
            <CardHeader>
              <CardTitle className="text-lg">
                {entity?.name || `Entity ${index + 1}`}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div>
                  <h4 className="font-semibold text-sm">Fields:</h4>
                  <ul className="text-sm text-gray-600 ml-4 list-disc">
                    {Object.entries(entity?.fields || {}).map(([field, type]) => (
                      <li key={field}>
                        <code className="font-mono">{field}</code>:{" "}
                        {String(type)}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="font-semibold text-sm">Relations:</h4>
                  <ul className="text-sm text-gray-600 ml-4 list-disc">
                    {Object.entries(entity?.relations || {}).map(
                      ([relation, desc]) => (
                        <li key={relation}>{String(desc)}</li>
                      ),
                    )}
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
