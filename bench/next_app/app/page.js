export default function Page() {
  const items = [1, 2, 3].map((n) => n * 2);
  return <main><h1>Hello from Next</h1><p>{items.join(", ")}</p></main>;
}
