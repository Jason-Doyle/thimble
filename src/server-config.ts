export function validateAzureReadBaseUrl(
  value: string,
  container: string,
  prefix: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("THIMBLE_READ_BASE_URL must be a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("THIMBLE_READ_BASE_URL must use HTTPS");
  }

  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const expectedPath = `/${container}/${normalizedPrefix}`;
  const actualPath = decodeURIComponent(url.pathname).replace(/\/+$/, "");
  if (actualPath !== expectedPath) {
    throw new Error(
      `THIMBLE_READ_BASE_URL must end with ${expectedPath}; received ${actualPath || "/"}`,
    );
  }

  const permissions = url.searchParams.get("sp");
  if (permissions !== "r") {
    throw new Error(
      "The browser SAS must have read permission only (sp=r)",
    );
  }

  if (!url.searchParams.get("sig")) {
    throw new Error("THIMBLE_READ_BASE_URL is missing a SAS signature");
  }

  return url.toString();
}

export function validateGenericReadBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("THIMBLE_READ_BASE_URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("THIMBLE_READ_BASE_URL must use HTTPS");
  }
  return url.toString();
}
