import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArchitectureData } from "../utils/types";

interface MicroservicesSectionProps {
  microservices: ArchitectureData["microservices"];
}

export default function MicroservicesSection({
  microservices,
}: MicroservicesSectionProps) {
  const services = Array.isArray(microservices) ? microservices : [];

  const renderList = (title: string, items: string[]) => {
    const safeItems = Array.isArray(items) ? items : [];
    if (!safeItems.length) return null;
    return (
      <div className="mt-3">
        <p className="text-xs font-semibold uppercase text-gray-500">{title}</p>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-gray-600">
          {safeItems.map((item, idx) => (
            <li key={`${title}-${idx}`}>{item}</li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {services.length === 0 ? (
        <Card>
          <CardContent className="pt-4 text-sm text-gray-600">
            Microservices are still streaming...
          </CardContent>
        </Card>
      ) : (
        services.map((service, index) => (
          <Card key={index}>
            <CardHeader>
              <CardTitle className="text-lg">
                {service?.name || `Service ${index + 1}`}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600 mb-2">
                {service?.responsibility || "No responsibility provided yet."}
              </p>
              <div className="flex flex-wrap gap-2">
                {(Array.isArray(service?.techStack) ? service.techStack : []).map(
                  (tech, idx) => (
                  <span
                    key={idx}
                    className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded"
                  >
                    {tech}
                  </span>
                  ),
                )}
              </div>
              {service?.details?.workflow && (
                <p className="mt-3 text-sm text-gray-700">
                  <span className="font-semibold">Workflow:</span>{" "}
                  {service.details.workflow}
                </p>
              )}
              {renderList("Inputs", service?.details?.inputs ?? [])}
              {renderList("Outputs", service?.details?.outputs ?? [])}
              {renderList(
                "Integration Points",
                service?.details?.integrationPoints ?? [],
              )}
              {renderList("Data Storage", service?.details?.dataStorage ?? [])}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
