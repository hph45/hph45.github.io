// Suggestions enhance free-text entry; saving a book never calls this service.
// The catalog RPC also works when the Edge Function itself cannot be reached.
export async function searchBooks(client, query, { signal } = {}) {
  const input = query.slice(0, 120);
  let result;
  try {
    result = await client.functions.invoke("search-books", { body: { query: input }, signal, timeout: 8000 });
  } catch (error) { result = { error }; }
  if (signal?.aborted) throw new Error("Search cancelled");
  if (!result.error && result.data?.books?.length) return result.data.books;

  let fallback = client.rpc("search_matchmaking_books", { query: input });
  if (signal) fallback = fallback.abortSignal(signal);
  const { data, error } = await fallback;
  if (signal?.aborted) throw new Error("Search cancelled");
  if (data?.length) return data;
  if (result.error || error) throw result.error || error;
  return [];
}
