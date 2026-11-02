import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function useDamagedFiles(enabled = true) {
  return useQuery({ queryKey: ["damaged-files"], queryFn: api.damagedFiles, enabled, refetchInterval: 30_000 });
}
