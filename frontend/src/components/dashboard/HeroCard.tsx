import React from 'react';
import './HeroCard.css';

export const HeroCard: React.FC = () => {
  const currentHour = new Date().getHours();
  let greeting = 'Good morning';
  
  if (currentHour >= 12 && currentHour < 17) {
    greeting = 'Good afternoon';
  } else if (currentHour >= 17) {
    greeting = 'Good evening';
  }

  return (
    <div className="hero-card">
      <div className="hero-card-bg-gradient" />
      
      <div className="hero-card-content">
        <h1 className="hero-greeting hero-card-hero-greeting">{greeting}</h1>
        <p className="hero-tagline hero-card-hero-tagline">Your personal workspace & command center</p>
      </div>
    </div>
  );
};
