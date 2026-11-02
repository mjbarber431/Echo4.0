declare module 'virtual:pdfjs-data' {
  const files: Record<string, () => Promise<string>>
  export default files
}
