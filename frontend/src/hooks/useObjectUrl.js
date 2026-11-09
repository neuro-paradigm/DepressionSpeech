import { useEffect, useState } from 'react';

export default function useObjectUrl(blob) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (!blob) {
      const raf = requestAnimationFrame(() => setUrl(''));
      return () => cancelAnimationFrame(raf);
    }
    const objectUrl = URL.createObjectURL(blob);
    const raf = requestAnimationFrame(() => setUrl(objectUrl));
    return () => {
      cancelAnimationFrame(raf);
      URL.revokeObjectURL(objectUrl);
    };
  }, [blob]);

  return url;
}
