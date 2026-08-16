import type { Metadata } from "next";
import NotebookApp from "./notebook-app";

export const metadata: Metadata = {
  title: "Notebook Digitizer",
  description: "A private, local-first notebook archive with Codex-assisted transcription.",
};

export default function Home() {
  return <NotebookApp />;
}
