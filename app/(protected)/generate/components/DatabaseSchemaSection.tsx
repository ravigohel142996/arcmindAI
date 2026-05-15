import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArchitectureData } from "../utils/types";

interface DatabaseSchemaSectionProps {
  schema: ArchitectureData["databaseSchema"];
}

export default function DatabaseSchemaSection({
  schema,
}: DatabaseSchemaSectionProps) {
  const databaseType =
    typeof schema?.type === "string" && schema.type.trim().length > 0
      ? schema.type
      : "Not specified yet";
  const collections = Array.isArray(schema?.collections)
    ? schema.collections
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-lg font-semibold">Database Type:</h3>
        <span className="px-3 py-1 bg-purple-100 text-purple-800 rounded">
          {databaseType}
        </span>
      </div>
      <div className="space-y-4">
        {collections.length === 0 ? (
          <Card>
            <CardContent className="pt-4 text-sm text-gray-600">
              Schema details are still streaming...
            </CardContent>
          </Card>
        ) : (
          collections.map((collection, index) => (
            <Card key={index}>
              <CardHeader>
                <CardTitle className="text-lg">
                  {collection?.name || `Collection ${index + 1}`}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
                  {Object.entries(collection?.fields || {}).map(
                    ([field, type]) => (
                      <div
                        key={field}
                        className="flex justify-between text-sm border-b border-gray-100 py-1"
                      >
                        <code className="font-mono">{field}</code>
                        <span className="text-gray-600">{String(type)}</span>
                      </div>
                    ),
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
