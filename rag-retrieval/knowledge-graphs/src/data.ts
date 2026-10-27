// The committed sample data, bundled into the app and loaded by the tests.
// Everything here is fixed input; everything derived from it (spans,
// resolution, graph, retrieval, verdicts) is computed by the code in src/.

import documents from "../data/documents.json" with { type: "json" };
import questions from "../data/questions.json" with { type: "json" };
import teams from "../data/extractions/teams.json" with { type: "json" };
import atlas from "../data/extractions/atlas-3.json" with { type: "json" };
import suppliers from "../data/extractions/suppliers.json" with { type: "json" };
import borealis from "../data/extractions/borealis.json" with { type: "json" };
import customers from "../data/extractions/customers.json" with { type: "json" };
import incident from "../data/extractions/incident.json" with { type: "json" };
import type { Extraction } from "./schema.ts";
import type { Doc } from "./retrieve.ts";
import type { Question } from "./compare.ts";

export const DOCUMENTS = documents as Doc[];
export const EXTRACTIONS = [teams, atlas, suppliers, borealis, customers, incident] as Extraction[];
export const QUESTIONS = questions as Question[];
