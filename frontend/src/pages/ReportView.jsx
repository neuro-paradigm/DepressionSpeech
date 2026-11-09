import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download } from 'lucide-react';
import { api } from '../api/client';
import { cacheGet, cacheSet, reportCacheKey } from '../utils/cache';
import ReportCard from '../components/ReportCard';

export default function ReportView() {
  const { id } = useParams();
  // Paint instantly from the cache (warmed by prefetching or a previous
  // visit), then revalidate in the background.
  const [reportData, setReportData] = useState(() => cacheGet(reportCacheKey(id)));
  const [loading, setLoading] = useState(() => !cacheGet(reportCacheKey(id)));
  const [error, setError] = useState('');
  const [scrollProgress, setScrollProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;

    function loadReport() {
      setError('');
      setLoading(!cacheGet(reportCacheKey(id)));
      api
        .get(`/get-report/${id}`)
        .then((response) => {
          if (cancelled) return;
          setReportData(response.data);
          cacheSet(reportCacheKey(id), response.data);
        })
        .catch((requestError) => {
          if (!cancelled) setError(requestError.response?.data?.message || 'Unable to load report.');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    loadReport();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Thin progress bar showing how far through the report the reader is.
  useEffect(() => {
    let raf = 0;
    function update() {
      raf = 0;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - window.innerHeight;
      setScrollProgress(scrollable > 0 ? Math.min(100, Math.max(0, (window.scrollY / scrollable) * 100)) : 0);
    }
    function onScroll() {
      if (!raf) raf = requestAnimationFrame(update);
    }
    // Defer the first computation to animation time.
    raf = requestAnimationFrame(update);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <main className="page report-page">
      <div className="reading-progress" aria-hidden="true">
        <span style={{ width: `${scrollProgress}%` }} />
      </div>

      <div className="report-view-actions no-print">
        <Link className="back-link" to="/admin">
          <ArrowLeft size={18} />
          Back to dashboard
        </Link>
        <button
          className="secondary pdf-download-button"
          type="button"
          onClick={() => window.print()}
          disabled={!reportData}
        >
          <Download size={18} />
          Download PDF
        </button>
      </div>

      {!reportData && loading && <p className="inline-status">Loading report…</p>}
      {error && (
        <p className="error">
          {error}
          {reportData && ' Showing the previously loaded copy.'}
        </p>
      )}
      {reportData && (
        <ReportCard
          report={reportData.report}
          user={reportData.user}
          responses={reportData.responses}
          combinedTranscript={reportData.combinedTranscript}
          combinedTranscriptUrl={reportData.combinedTranscriptUrl}
          zipUploadError={reportData.zipUploadError}
        />
      )}
    </main>
  );
}
