// frontend/src/pages/Profile.jsx
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

const Profile = () => {
  const [myRaffles, setMyRaffles] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const rafflesPerPage = 6;
  const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

  // Fetch the currently connected Kaspa address using KasWare.
  const getConnectedAddress = async () => {
    try {
      const accounts = await window.kasware.getAccounts();
      return accounts[0];
    } catch (error) {
      console.error('Error fetching connected account:', error);
      return null;
    }
  };

  // Fetch raffles for the connected account.
  const fetchMyRaffles = async () => {
    try {
      const currentAddress = await getConnectedAddress();
      if (!currentAddress) return;
      
      // Use encodeURIComponent in case the address has special characters.
      const res = await axios.get(`${apiUrl}/raffles?creator=${encodeURIComponent(currentAddress)}`);
      if (res.data.success) {
        // Separate live and completed raffles.
        const live = res.data.raffles.filter(r => r.status === 'live');
        const completed = res.data.raffles.filter(r => r.status !== 'live');

        // Sort live raffles: ending soonest first.
        live.sort((a, b) => new Date(a.timeFrame) - new Date(b.timeFrame));

        // Sort completed raffles: most recently completed first.
        completed.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

        // Merge arrays: live ones first, then completed.
        const sortedRaffles = [...live, ...completed];
        setMyRaffles(sortedRaffles);
      }
    } catch (err) {
      console.error('Error fetching user raffles:', err);
    }
  };

  useEffect(() => {
    // Fetch raffles when the component mounts and whenever the API URL changes.
    fetchMyRaffles();
    // Optionally, you could set an interval if you want auto‑refresh:
    // const interval = setInterval(fetchMyRaffles, 1000);
    // return () => clearInterval(interval);
  }, [apiUrl]);

  // Pagination calculations.
  const indexOfLast = currentPage * rafflesPerPage;
  const indexOfFirst = indexOfLast - rafflesPerPage;
  const currentRaffles = myRaffles.slice(indexOfFirst, indexOfLast);
  const totalPages = Math.ceil(myRaffles.length / rafflesPerPage);

  return (
    <div className="profile-page page-container">
      {/* Global heading is centered using the global-heading class */}
      <h1 className="global-heading">My Raffles</h1>
      {myRaffles.length === 0 ? (
        <p>You haven't created any raffles yet.</p>
      ) : (
        <>
          <div className="raffles-grid">
            {currentRaffles.map((raffle) => (
              <Link
                key={raffle.raffleId}
                to={`/raffle/${raffle.raffleId}`}
                className={`profile-raffle-card ${raffle.status === "completed" ? "completed" : ""}`}
              >
                <h3>{raffle.prizeDisplay}</h3>
                <p>Entries: {raffle.currentEntries.toFixed(2)}</p>
                <p>
                  {raffle.status === "live"
                    ? `Time Left: ${new Date(raffle.timeFrame).toLocaleString()}`
                    : `Completed - Winner: ${raffle.winner ? raffle.winner : "No Entries"}`}
                </p>
              </Link>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="pagination">
              <button
                onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                disabled={currentPage === 1}
              >
                Previous
              </button>
              <span>Page {currentPage} of {totalPages}</span>
              <button
                onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                disabled={currentPage === totalPages}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default Profile;
