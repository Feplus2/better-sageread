export interface CsvPreviewData {
  headers: string[];
  rows: string[][];
  truncated: boolean;
}

interface CsvPreviewOptions {
  maxRows?: number;
  allowPartial?: boolean;
}

export function parseCsvPreview(text: string, options: CsvPreviewOptions = {}): CsvPreviewData {
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? 200));
  const allowPartial = options.allowPartial === true;
  const headers: string[] = [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let rowStarted = false;
  let truncated = false;

  const appendRow = () => {
    if (headers.length === 0) {
      headers.push(...row, field);
      return;
    }
    const values = [...row, field];
    while (values.length < headers.length) values.push("");
    if (values.length > headers.length) {
      for (const previous of rows) {
        while (previous.length < values.length) previous.push("");
      }
      for (let index = headers.length; index < values.length; index += 1) headers.push(`列${index + 1}`);
    }
    rows.push(values);
  };

  for (let index = 0; index < text.length; index += 1) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
      rowStarted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      rowStarted = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      if (rowStarted || row.length > 0) appendRow();
      row = [];
      field = "";
      rowStarted = false;
    } else {
      field += char;
      rowStarted = true;
    }
  }

  if (quoted) {
    if (!allowPartial) throw new Error("CSV 引号未闭合");
    truncated = true;
  } else if (!truncated && (rowStarted || row.length > 0)) {
    appendRow();
  }
  return { headers, rows, truncated };
}
