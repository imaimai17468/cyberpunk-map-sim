import { createFileRoute } from "@tanstack/react-router";
import { CityMapPage } from "@/components/features/city-map/CityMapPage";

export const Route = createFileRoute("/map")({
  component: CityMapPage,
});
